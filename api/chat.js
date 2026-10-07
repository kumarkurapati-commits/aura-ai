// AURA AI — Vercel Edge Function
// Proxies chat to Google Gemini (free tier) and streams plain text back.
// - If FIREBASE_PROJECT_ID is set, only signed-in users (valid Firebase ID token) can use it.
// - Supports images / PDFs, "smart" vs "fast" models, Google Search grounding, and chat titles.
// - Returns {fallback:true} on quota / rate-limit / outage so the browser can switch to the on-device model.
// - GET /api/chat is a health check you can open in a browser.

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are AURA AI, a helpful, friendly and concise assistant. Use Markdown for structure when it helps (lists, tables, code blocks).';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';

// Models to try, in order. "-latest" aliases follow Google's newest stable models automatically.
const uniq = (a) => a.filter((m, i) => m && a.indexOf(m) === i);
// Extra named models are a safety net in case an alias is busy (unknown names are skipped automatically).
const MODEL_CHAINS = {
  smart: uniq([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite']),
  fast: uniq([process.env.GEMINI_FAST_MODEL, 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest']),
};
const TIME_BUDGET_MS = 60000; // stop trying more models after this long
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (status) => status === 503 || status === 500 || status === 504;

const MAX_MSG_CHARS = 12000;          // per message (text files are inlined, so allow more)
const MAX_INSTRUCTION_CHARS = 2000;   // project instructions / "about you"
const MAX_HISTORY = 24;               // messages sent upstream
const MAX_FILE_BYTES_TOTAL = 3_500_000; // base64 payload cap per request (Vercel limit is ~4 MB)
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|heic|heif|gif)|application\/pdf)$/;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 40); // requests per user per window
const RATE_WINDOW_MS = 10 * 60 * 1000;

// ---------- Rate limiting (best-effort, per edge instance) ----------
const hits = new Map();
function isLimited(id) {
  const now = Date.now();
  const h = hits.get(id);
  if (!h || now > h.reset) {
    hits.set(id, { count: 1, reset: now + RATE_WINDOW_MS });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  h.count += 1;
  return h.count > RATE_LIMIT;
}

// ---------- Firebase ID token verification (no dependencies) ----------
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: null, exp: 0 };

async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks_unavailable');
  const j = await r.json();
  const m = (r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  jwksCache = { keys: j.keys || [], exp: Date.now() + (m ? Number(m[1]) * 1000 : 3600 * 1000) };
  return jwksCache.keys;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyFirebaseToken(token, projectId) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const dec = new TextDecoder();
  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const jwk = (await getJwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.aud !== projectId ||
    payload.iss !== `https://securetoken.google.com/${projectId}` ||
    !payload.sub ||
    !(payload.exp > now) ||
    payload.iat > now + 300
  ) {
    return null;
  }
  return payload;
}

// ---------- Helpers ----------
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// The timeout only covers waiting for Google to START answering; a long answer can keep streaming.
async function callGemini(model, body, key, stream, startTimeoutMs = 30000) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    (stream ? ':streamGenerateContent?alt=sse' : ':generateContent');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), startTimeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    return null; // timed out or unreachable
  } finally {
    clearTimeout(timer);
  }
}

// Models that just failed (busy / timed out) are tried last for a couple of minutes.
const coolDown = new Map();
const COOL_DOWN_MS = 2 * 60 * 1000;
function orderByHealth(chain) {
  const now = Date.now();
  const ok = chain.filter((m) => !(coolDown.get(m) > now));
  const cooling = chain.filter((m) => coolDown.get(m) > now);
  return [...ok, ...cooling];
}

// Turn the browser's message list into Gemini "contents".
function buildContents(msgs) {
  let fileBytes = 0;
  const contents = [];
  for (const m of msgs.slice(-MAX_HISTORY)) {
    if (!m || typeof m.content !== 'string') continue;
    const parts = [];
    if (Array.isArray(m.files)) {
      for (const f of m.files.slice(0, 6)) {
        if (!f || typeof f.data !== 'string' || !ALLOWED_MIME.test(f.mimeType || '')) continue;
        fileBytes += f.data.length;
        if (fileBytes > MAX_FILE_BYTES_TOTAL) continue;
        parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
      }
    }
    const text = m.content.slice(0, MAX_MSG_CHARS);
    if (text.trim()) parts.push({ text });
    if (!parts.length) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

// GET /api/chat            -> quick health check you can open in a browser.
// GET /api/chat?full=1     -> tests every model, with text and with a small image.
const TEST_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDVooor88P0cKKKKACiiigAooooA//Z';
async function healthCheck(req) {
  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (isLimited('health:' + ip)) return json(429, { error: 'rate_limited' });
  const full = new URL(req.url).searchParams.get('full') === '1';
  const key = process.env.GEMINI_API_KEY;
  const out = {
    geminiKeySet: !!key,
    firebaseProjectId: FIREBASE_PROJECT_ID || '(not set: sign-in not enforced)',
    models: [],
  };
  const probe = async (model, withImage) => {
    const parts = [{ text: withImage ? 'What colour is this image? One word.' : 'Reply with the single word: ok' }];
    if (withImage) parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: TEST_JPEG } });
    const t0 = Date.now();
    const r = await callGemini(model, { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 10 } }, key, false, 20000);
    let detail = '';
    if (r && !r.ok) { try { detail = ((await r.json()).error || {}).message || ''; } catch { /* ignore */ } }
    return { model, test: withImage ? 'image' : 'text', status: r ? r.status : 'timeout', works: !!(r && r.ok), seconds: Math.round((Date.now() - t0) / 100) / 10, detail: detail.slice(0, 200) };
  };
  if (key) {
    const models = full ? uniq([...MODEL_CHAINS.smart, ...MODEL_CHAINS.fast]) : MODEL_CHAINS.smart;
    if (full) {
      out.models = await Promise.all(models.flatMap((m) => [probe(m, false), probe(m, true)]));
    } else {
      for (const model of models) {
        const res = await probe(model, false);
        out.models.push(res);
        if (res.works) break;
      }
    }
  }
  out.cloudWorking = out.models.some((m) => m.works && m.test === 'text');
  if (full) out.imagesWorking = out.models.some((m) => m.works && m.test === 'image');
  return json(200, out);
}

// mode: "title" -> short title for a conversation (non-streaming JSON).
async function makeTitle(contents, key) {
  const transcript = contents
    .map((c) => (c.role === 'model' ? 'Assistant: ' : 'User: ') + c.parts.filter((p) => p.text).map((p) => p.text).join(' '))
    .join('\n')
    .slice(0, 3000);
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Write a short title (3 to 6 words, no quotes, no trailing punctuation) for this conversation. Reply with the title only.\n\n' + transcript }] }],
    generationConfig: { maxOutputTokens: 24, temperature: 0.3 },
  };
  for (const model of MODEL_CHAINS.fast) {
    const r = await callGemini(model, body, key, false, 12000);
    if (r && r.ok) {
      const d = await r.json().catch(() => ({}));
      const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      const title = t.replace(/^["'“”‘’\s#*]+|["'“”‘’\s.*]+$/g, '').slice(0, 60);
      if (title) return json(200, { title });
    }
  }
  return json(502, { error: 'title_failed' });
}

// ---------- Handler ----------
export default async function handler(req) {
  if (req.method === 'GET') return healthCheck(req);
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Who is calling?
  let callerId = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (FIREBASE_PROJECT_ID) {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let claims = null;
    try {
      claims = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
    } catch {
      claims = null;
    }
    if (!claims) return json(401, { error: 'Please sign in again', fallback: false });
    callerId = 'u:' + claims.sub;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(503, { error: 'not_configured', fallback: true });
  if (isLimited(callerId)) return json(429, { error: 'rate_limited', fallback: true });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(413, { error: 'Request too large or invalid. Try a smaller file.', fallback: false });
  }

  const contents = buildContents(Array.isArray(body?.messages) ? body.messages : []);
  if (!contents.length) return json(400, { error: 'no_user_message', fallback: false });

  if (body.mode === 'title') return makeTitle(contents, key);

  if (contents[contents.length - 1].role !== 'user') {
    return json(400, { error: 'no_user_message', fallback: false });
  }

  let system = SYSTEM_PROMPT;
  if (typeof body.about === 'string' && body.about.trim()) {
    system += '\n\nAbout the user (they wrote this themselves; use it when relevant):\n' + body.about.slice(0, MAX_INSTRUCTION_CHARS);
  }
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    system +=
      '\n\nThe user has set these instructions for this project. Follow them unless they conflict with being safe and honest:\n' +
      body.instructions.slice(0, MAX_INSTRUCTION_CHARS);
  }

  const wantSearch = body.search === true;
  const chain = MODEL_CHAINS[body.model === 'fast' ? 'fast' : 'smart'];
  const base = {
    contents,
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
  };

  // Start replying straight away (Vercel needs a first byte within ~25 s), then try the models
  // in the background. Heartbeat bytes (\u0001) keep the connection alive while Google thinks.
  // The stream ends with \u0000{meta}: sources on success, or {error, fallback} if every model failed.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      let gotText = false;
      const beat = setInterval(() => { if (!gotText) { try { ctrl.enqueue(encoder.encode('\u0001')); } catch { /* closed */ } } }, 4000);
      ctrl.enqueue(encoder.encode('\u0001'));
      const finish = (meta) => {
        clearInterval(beat);
        try { ctrl.enqueue(encoder.encode('\u0000' + JSON.stringify(meta))); ctrl.close(); } catch { /* closed */ }
      };

      let upstream = null, usedModel = '', searchUsed = false;
      const started = Date.now();
      const attempts = [];
      outer: for (const model of orderByHealth(chain)) {
        const searchModes = wantSearch ? [true, false] : [false];
        for (const withSearch of searchModes) {
          if (Date.now() - started > TIME_BUDGET_MS) break outer;
          const reqBody = withSearch ? { ...base, tools: [{ googleSearch: {} }] } : base;
          let r = await callGemini(model, reqBody, key, true, 12000);
          if (r && !r.ok && isBusy(r.status) && !(coolDown.get(model) > Date.now())) {
            await sleep(800); // Google is briefly overloaded: one quick retry before moving on
            r = await callGemini(model, reqBody, key, true, 12000);
          }
          if (r && r.ok) { upstream = r; usedModel = model; searchUsed = withSearch; coolDown.delete(model); break outer; }
          const status = r ? r.status : 'timeout';
          if (status === 'timeout' || isBusy(status) || status === 429) coolDown.set(model, Date.now() + COOL_DOWN_MS);
          let detail = '';
          if (r) { try { detail = ((await r.json()).error || {}).message || ''; } catch { /* ignore */ } }
          attempts.push({ model, search: withSearch, status, detail: detail.slice(0, 160) });
          if (status === 400 && !withSearch) {
            // A 400 without search usually means a file Google can't read; other models won't help.
            return finish({ error: 'Google could not read that request' + (detail ? ': ' + detail.slice(0, 160) : ''), fallback: false, attempts });
          }
        }
      }

      if (!upstream) {
        const real = attempts.filter((a) => a.status !== 404).map((a) => a.status);
        console.log('AURA: all models failed', JSON.stringify(attempts));
        return finish({
          error: real.includes(429) ? 'quota_exceeded' : real.some((x) => isBusy(x) || x === 'timeout') ? 'google_busy' : 'upstream_error',
          status: real[real.length - 1] || attempts[attempts.length - 1]?.status || 0,
          attempts,
          fallback: true,
        });
      }

      // Relay Gemini's SSE stream as plain text.
      const sources = new Map();
      let buf = '';
      const handle = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const d = JSON.parse(payload);
          const cand = d.candidates?.[0];
          const text = (cand?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
          if (text) { gotText = true; ctrl.enqueue(encoder.encode(text.replace(/[\u0000\u0001]/g, ''))); }
          for (const ch of cand?.groundingMetadata?.groundingChunks || []) {
            if (ch.web?.uri && sources.size < 8) sources.set(ch.web.uri, ch.web.title || ch.web.uri);
          }
        } catch { /* ignore partial / non-JSON lines */ }
      };
      try {
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) handle(line);
        }
        if (buf) handle(buf);
      } catch (e) {
        if (!gotText) return finish({ error: 'google_busy', status: 'stream_failed', fallback: true });
      }
      finish({
        model: usedModel,
        searchUsed,
        searchUnavailable: wantSearch && !searchUsed,
        sources: [...sources].map(([uri, title]) => ({ uri, title })),
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-chat-mode': 'cloud',
    },
  });
}
