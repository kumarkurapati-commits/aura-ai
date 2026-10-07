// AURA AI — Vercel Edge Function
// Streams answers from free AI models: Google Gemini (GEMINI_API_KEY) and, optionally,
// free models on OpenRouter (OPENROUTER_API_KEY).
// - If FIREBASE_PROJECT_ID is set, only signed-in users (valid Firebase ID token) can use it.
// - Model picker + thinking levels, images / PDFs, Google Search, chat titles.
// - If the chosen model fails it falls back to other models; if all fail the browser uses its on-device model.
// - GET /api/chat            health check            GET /api/chat?full=1  test every model
//   GET /api/chat?models=1   list of models for the picker

export const config = { runtime: 'edge' };

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are AURA AI, a helpful, friendly and concise assistant. Use Markdown for structure when it helps (lists, tables, code blocks).';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const uniq = (a) => a.filter((m, i) => m && a.indexOf(m) === i);

// ---------- Model catalog (edit this list to add or remove models) ----------
// provider "gemini": `models` are tried in order.  provider "openrouter": one model id.
// Free OpenRouter models change often: see https://openrouter.ai/models?max_price=0
const CATALOG = [
  { id: 'auto', label: 'Auto', desc: 'Best available model. Switches automatically if one is busy.', provider: 'gemini',
    models: uniq([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite']), vision: true, pdf: true, search: true },
  { id: 'gemini-flash', label: 'Gemini Flash', desc: "Google's main model. Strong all-rounder.", provider: 'gemini',
    models: ['gemini-flash-latest'], vision: true, pdf: true, search: true },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', desc: "Google's newest Flash version.", provider: 'gemini',
    models: ['gemini-3.8-flash'], vision: true, pdf: true, search: true },
  { id: 'gemini-lite', label: 'Gemini Flash-Lite', desc: 'Fastest replies and the most free capacity.', provider: 'gemini',
    models: ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'], vision: true, pdf: true, search: true },
  { id: 'nemotron-ultra', label: 'NVIDIA Nemotron Ultra', desc: 'Very large open model (550B). Text only.', provider: 'openrouter',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free', vision: false },
  { id: 'gemma-4', label: 'Google Gemma 4', desc: "Google's open model (31B). Understands images.", provider: 'openrouter',
    model: 'google/gemma-4-31b-it:free', vision: true },
  { id: 'nemotron-super', label: 'NVIDIA Nemotron Super', desc: 'Large open model (120B). Fast, text only.', provider: 'openrouter',
    model: 'nvidia/nemotron-3-super-120b-a12b:free', vision: false },
  { id: 'laguna', label: 'Poolside Laguna', desc: 'Specialised for writing and fixing code.', provider: 'openrouter',
    model: 'poolside/laguna-s-2.1:free', vision: false },
  { id: 'or-free', label: 'Free model router', desc: 'OpenRouter picks any free model that is available.', provider: 'openrouter',
    model: 'openrouter/free', vision: true },
];
const byId = (id) => CATALOG.find((m) => m.id === id);
const available = (m) => m.provider === 'gemini' || !!OPENROUTER_KEY;
const EFFORTS = ['fast', 'balanced', 'deep'];

const TIME_BUDGET_MS = 60000;
const START_TIMEOUT_MS = 12000;      // give up on a model that hasn't started answering after this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (status) => status === 503 || status === 500 || status === 504 || status === 502;

const MAX_MSG_CHARS = 12000;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_HISTORY = 24;
const MAX_FILE_BYTES_TOTAL = 3_500_000;
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|heic|heif|gif)|application\/pdf)$/;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 40);
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
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

// The timeout only covers waiting for the provider to START answering; a long answer keeps streaming.
async function timedFetch(url, init, startTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), startTimeoutMs);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

function callGemini(model, body, key, stream, startTimeoutMs = 30000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    (stream ? ':streamGenerateContent?alt=sse' : ':generateContent');
  return timedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, startTimeoutMs);
}

function callOpenRouter(body, startTimeoutMs = 30000) {
  return timedFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + OPENROUTER_KEY,
      'HTTP-Referer': 'https://aura-ai.vercel.app',
      'X-Title': 'AURA AI',
    },
    body: JSON.stringify(body),
  }, startTimeoutMs);
}

async function errorDetail(r) {
  if (!r) return '';
  try { const j = await r.json(); return (j.error && (j.error.message || j.error.metadata?.raw)) || ''; } catch { return ''; }
}

// Models that just failed (busy / timed out / rate-limited) are tried last for a couple of minutes.
const coolDown = new Map();
const COOL_DOWN_MS = 2 * 60 * 1000;
const cooling = (name) => coolDown.get(name) > Date.now();

// Normalise the browser's messages: [{ role, text, files: [{mimeType, data}] }]
function normalise(msgs) {
  let fileBytes = 0;
  const out = [];
  for (const m of msgs.slice(-MAX_HISTORY)) {
    if (!m || typeof m.content !== 'string') continue;
    const files = [];
    if (Array.isArray(m.files)) {
      for (const f of m.files.slice(0, 6)) {
        if (!f || typeof f.data !== 'string' || !ALLOWED_MIME.test(f.mimeType || '')) continue;
        fileBytes += f.data.length;
        if (fileBytes > MAX_FILE_BYTES_TOTAL) continue;
        files.push({ mimeType: f.mimeType, data: f.data });
      }
    }
    const text = m.content.slice(0, MAX_MSG_CHARS);
    if (!text.trim() && !files.length) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text, files });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function toGeminiContents(msgs) {
  return msgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [...m.files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })), ...(m.text.trim() ? [{ text: m.text }] : [])],
  }));
}

function toOpenAIMessages(msgs, system) {
  return [{ role: 'system', content: system }, ...msgs.map((m) => {
    const imgs = m.files.filter((f) => f.mimeType.startsWith('image/'));
    if (!imgs.length) return { role: m.role, content: m.text || '(attachment)' };
    return { role: m.role, content: [
      ...(m.text.trim() ? [{ type: 'text', text: m.text }] : []),
      ...imgs.map((f) => ({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.data}` } })),
    ] };
  })];
}

function geminiBody(contents, system, effort, withSearch, useThinking = true) {
  const generationConfig = { maxOutputTokens: effort === 'deep' ? 8192 : 4096, temperature: 0.7 };
  if (useThinking && effort === 'fast') generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  if (useThinking && effort === 'deep') generationConfig.thinkingConfig = { thinkingLevel: 'high' };
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (withSearch) body.tools = [{ googleSearch: {} }];
  return body;
}

function openRouterBody(model, messages, effort, stream, useThinking = true, maxTokens = 4096) {
  const body = { model, messages, stream, max_tokens: effort === 'deep' ? 8192 : maxTokens };
  if (useThinking && effort === 'fast') body.reasoning = { effort: 'low' };
  if (useThinking && effort === 'deep') body.reasoning = { effort: 'high' };
  return body;
}

// ---------- GET endpoints ----------
const TEST_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDVooor88P0cKKKKACiiigAooooA//Z';

async function modelList() {
  return json(200, {
    openrouter: !!OPENROUTER_KEY,
    models: CATALOG.filter(available).map(({ id, label, desc, provider, vision }) => ({ id, label, desc, provider, vision: !!vision })),
  }, { 'cache-control': 'public, max-age=300' });
}

async function healthCheck(req) {
  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (isLimited('health:' + ip)) return json(429, { error: 'rate_limited' });
  const full = new URL(req.url).searchParams.get('full') === '1';
  const key = process.env.GEMINI_API_KEY;
  const out = {
    geminiKeySet: !!key,
    openrouterKeySet: !!OPENROUTER_KEY,
    firebaseProjectId: FIREBASE_PROJECT_ID || '(not set: sign-in not enforced)',
    models: [],
  };
  const probe = async (provider, model, withImage) => {
    const t0 = Date.now();
    const question = withImage ? 'What colour is this image? One word.' : 'Reply with the single word: ok';
    const msgs = [{ role: 'user', text: question, files: withImage ? [{ mimeType: 'image/jpeg', data: TEST_JPEG }] : [] }];
    const r = provider === 'gemini'
      ? await callGemini(model, { contents: toGeminiContents(msgs), generationConfig: { maxOutputTokens: 10 } }, key, false, 20000)
      : await callOpenRouter({ model, messages: toOpenAIMessages(msgs, 'Be brief.'), max_tokens: 20 }, 20000);
    const detail = r && !r.ok ? await errorDetail(r) : '';
    return { provider, model, test: withImage ? 'image' : 'text', status: r ? r.status : 'timeout', works: !!(r && r.ok), seconds: Math.round((Date.now() - t0) / 100) / 10, detail: String(detail).slice(0, 200) };
  };
  if (full) {
    const jobs = [];
    const seen = new Set();
    for (const spec of CATALOG.filter(available)) {
      const names = spec.provider === 'gemini' ? spec.models : [spec.model];
      for (const name of names) {
        if (seen.has(name) || (spec.provider === 'gemini' && !key)) continue;
        seen.add(name);
        jobs.push(probe(spec.provider, name, false));
        if (spec.vision) jobs.push(probe(spec.provider, name, true));
      }
    }
    out.models = await Promise.all(jobs);
  } else if (key) {
    for (const model of byId('auto').models) {
      const res = await probe('gemini', model, false);
      out.models.push(res);
      if (res.works) break;
    }
  }
  out.cloudWorking = out.models.some((m) => m.works && m.test === 'text');
  if (full) out.imagesWorking = out.models.some((m) => m.works && m.test === 'image');
  return json(200, out);
}

// mode: "title" -> short title for a conversation (non-streaming JSON).
async function makeTitle(msgs, key) {
  const transcript = msgs.map((m) => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + m.text).join('\n').slice(0, 3000);
  const prompt = 'Write a short title (3 to 6 words, no quotes, no trailing punctuation) for this conversation. Reply with the title only.\n\n' + transcript;
  const clean = (t) => t.trim().replace(/^["'“”‘’\s#*]+|["'“”‘’\s.*]+$/g, '').slice(0, 60);
  for (const model of byId('gemini-lite').models) {
    if (cooling(model)) continue;
    const r = await callGemini(model, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 24, temperature: 0.3 } }, key, false, 10000);
    if (r && r.ok) {
      const d = await r.json().catch(() => ({}));
      const t = clean((d.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join(''));
      if (t) return json(200, { title: t });
    }
  }
  if (OPENROUTER_KEY) {
    const r = await callOpenRouter({ model: 'openrouter/free', messages: [{ role: 'user', content: prompt }], max_tokens: 30 }, 10000);
    if (r && r.ok) {
      const d = await r.json().catch(() => ({}));
      const t = clean(d.choices?.[0]?.message?.content || '');
      if (t) return json(200, { title: t });
    }
  }
  return json(502, { error: 'title_failed' });
}

// ---------- Handler ----------
export default async function handler(req) {
  if (req.method === 'GET') {
    return new URL(req.url).searchParams.get('models') === '1' ? modelList() : healthCheck(req);
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  let callerId = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (FIREBASE_PROJECT_ID) {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let claims = null;
    try { claims = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID); } catch { claims = null; }
    if (!claims) return json(401, { error: 'Please sign in again', fallback: false });
    callerId = 'u:' + claims.sub;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key && !OPENROUTER_KEY) return json(503, { error: 'not_configured', fallback: true });
  if (isLimited(callerId)) return json(429, { error: 'rate_limited', fallback: true });

  let body;
  try { body = await req.json(); }
  catch { return json(413, { error: 'Request too large or invalid. Try a smaller file.', fallback: false }); }

  const msgs = normalise(Array.isArray(body?.messages) ? body.messages : []);
  if (!msgs.length) return json(400, { error: 'no_user_message', fallback: false });
  if (body.mode === 'title') return makeTitle(msgs, key);
  if (msgs[msgs.length - 1].role !== 'user') return json(400, { error: 'no_user_message', fallback: false });

  let system = SYSTEM_PROMPT;
  if (typeof body.about === 'string' && body.about.trim()) {
    system += '\n\nAbout the user (they wrote this themselves; use it when relevant):\n' + body.about.slice(0, MAX_INSTRUCTION_CHARS);
  }
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    system += '\n\nThe user has set these instructions for this project. Follow them unless they conflict with being safe and honest:\n' +
      body.instructions.slice(0, MAX_INSTRUCTION_CHARS);
  }

  // ---- Decide which models to try ----
  const effort = EFFORTS.includes(body.effort) ? body.effort : 'balanced';
  const wantSearch = body.search === true;
  const legacy = body.model === 'fast' ? 'gemini-lite' : null;
  let chosen = byId(body.modelId || legacy || 'auto') || byId('auto');
  if (!available(chosen) || (chosen.provider === 'gemini' && !key)) chosen = key ? byId('auto') : byId('or-free');
  const hasImage = msgs.some((m) => m.files.some((f) => f.mimeType.startsWith('image/')));
  const hasPdf = msgs.some((m) => m.files.some((f) => f.mimeType === 'application/pdf'));
  let note = '';
  const requested = chosen;
  if (key && hasPdf && !chosen.pdf) { chosen = byId('auto'); note = `${requested.label} can't read PDFs, so Gemini answered.`; }
  else if (key && hasImage && !chosen.vision) { chosen = byId('auto'); note = `${requested.label} can't see images, so Gemini answered.`; }
  else if (key && wantSearch && !chosen.search) { chosen = byId('auto'); note = `Web search works with Gemini, so Gemini answered.`; }

  const plan = []; // [{ spec, name }]
  const add = (spec) => {
    if (!spec || !available(spec)) return;
    if (spec.provider === 'gemini' && !key) return;
    for (const name of spec.provider === 'gemini' ? spec.models : [spec.model]) {
      if (!plan.some((p) => p.name === name)) plan.push({ spec, name });
    }
  };
  add(chosen);
  if (chosen.id !== 'auto') add(byId('auto'));
  if (!hasPdf && (!hasImage || byId('or-free').vision)) add(byId('or-free'));
  // Healthy models first (keeps the chosen model first unless it is cooling down).
  plan.sort((a, b) => (cooling(a.name) ? 1 : 0) - (cooling(b.name) ? 1 : 0));

  // Start replying straight away (Vercel needs a first byte within ~25 s), then try the models.
  // Heartbeat bytes (\u0001) keep the connection alive. The stream ends with \u0000{meta}.
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

      const started = Date.now();
      const attempts = [];
      let upstream = null, used = null, searchUsed = false;

      const tryOnce = (p, withSearch, useThinking) => p.spec.provider === 'gemini'
        ? callGemini(p.name, geminiBody(toGeminiContents(msgs), system, effort, withSearch, useThinking), key, true, START_TIMEOUT_MS)
        : callOpenRouter(openRouterBody(p.name, toOpenAIMessages(msgs, system), effort, true, useThinking), START_TIMEOUT_MS);

      outer: for (const p of plan) {
        const searchModes = wantSearch && p.spec.provider === 'gemini' ? [true, false] : [false];
        for (const withSearch of searchModes) {
          if (Date.now() - started > TIME_BUDGET_MS) break outer;
          let useThinking = effort !== 'balanced';
          let r = await tryOnce(p, withSearch, useThinking);
          if (r && r.status === 400 && useThinking) { useThinking = false; r = await tryOnce(p, withSearch, false); } // model doesn't support thinking levels
          if (r && !r.ok && isBusy(r.status) && !cooling(p.name)) { await sleep(800); r = await tryOnce(p, withSearch, useThinking); }
          if (r && r.ok) { upstream = r; used = p; searchUsed = withSearch; coolDown.delete(p.name); break outer; }
          const status = r ? r.status : 'timeout';
          const detail = String(await errorDetail(r)).slice(0, 160);
          attempts.push({ model: p.name, search: withSearch, status, detail });
          if (status === 'timeout' || isBusy(status) || status === 429 || status === 402) coolDown.set(p.name, Date.now() + COOL_DOWN_MS);
          if (status === 400 && !withSearch && p.spec.provider === 'gemini' && (hasImage || hasPdf)) {
            return finish({ error: 'Google could not read that file' + (detail ? ': ' + detail : ''), fallback: false, attempts });
          }
        }
      }

      if (!upstream) {
        const real = attempts.filter((a) => a.status !== 404).map((a) => a.status);
        console.log('AURA: all models failed', JSON.stringify(attempts));
        return finish({
          error: real.includes(429) || real.includes(402) ? 'quota_exceeded' : real.some((x) => isBusy(x) || x === 'timeout') ? 'google_busy' : 'upstream_error',
          status: real[real.length - 1] || attempts[attempts.length - 1]?.status || 0,
          attempts,
          fallback: true,
        });
      }

      // Relay the provider's SSE stream as plain text.
      const sources = new Map();
      let buf = '';
      let streamError = '';
      const emit = (text) => { if (text) { gotText = true; ctrl.enqueue(encoder.encode(text.replace(/[\u0000\u0001]/g, ''))); } };
      const handle = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const d = JSON.parse(payload);
          if (used.spec.provider === 'gemini') {
            const cand = d.candidates?.[0];
            emit((cand?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join(''));
            for (const ch of cand?.groundingMetadata?.groundingChunks || []) {
              if (ch.web?.uri && sources.size < 8) sources.set(ch.web.uri, ch.web.title || ch.web.uri);
            }
          } else {
            if (d.error) { streamError = d.error.message || 'error'; return; }
            emit(d.choices?.[0]?.delta?.content || '');
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
      } catch { /* connection dropped */ }
      if (!gotText) return finish({ error: 'google_busy', status: streamError || 'stream_failed', fallback: true });

      const fellBack = used.spec.id !== requested.id && !note;
      finish({
        model: used.name,
        modelId: used.spec.id,
        modelLabel: used.spec.id === 'auto' ? labelFor(used.name) : used.spec.label,
        requested: requested.id,
        note: note || (fellBack ? `${requested.label} was busy, so ${used.spec.id === 'auto' ? labelFor(used.name) : used.spec.label} answered.` : ''),
        effort,
        searchUsed,
        searchUnavailable: wantSearch && !searchUsed,
        sources: [...sources].map(([uri, title]) => ({ uri, title })),
      });
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-chat-mode': 'cloud' },
  });
}

// Friendly name for a Gemini model id, e.g. "gemini-flash-lite-latest" -> "Gemini Flash-Lite".
function labelFor(name) {
  const spec = CATALOG.find((m) => m.id !== 'auto' && (m.models || []).includes(name));
  return spec ? spec.label : name;
}
