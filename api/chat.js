// AURA AI — Vercel Edge Function
// Proxies chat to Google Gemini (free tier) and streams plain text back.
// - If FIREBASE_PROJECT_ID is set, only signed-in users (valid Firebase ID token) can use it.
// - Returns {fallback:true} on quota / rate-limit / outage so the browser can switch to the on-device model.

export const config = { runtime: 'edge' };

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || 'You are AURA AI, a helpful, friendly and concise assistant.';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
const MAX_MSG_CHARS = 4000;          // per message
const MAX_INSTRUCTION_CHARS = 2000;  // project instructions
const MAX_HISTORY = 20;              // messages sent upstream
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30); // requests per user/IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;                    // 10 minutes

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

// ---------- Handler ----------
export default async function handler(req) {
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
    return json(400, { error: 'bad_json', fallback: false });
  }

  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-MAX_HISTORY) : [];
  const contents = msgs
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content.slice(0, MAX_MSG_CHARS) }],
    }));
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return json(400, { error: 'no_user_message', fallback: false });
  }

  let system = SYSTEM_PROMPT;
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    system +=
      '\n\nThe user has set these instructions for this project. Follow them unless they conflict with being safe and honest:\n' +
      body.instructions.slice(0, MAX_INSTRUCTION_CHARS);
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}` +
    `:streamGenerateContent?alt=sse`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
    }),
  }).catch(() => null);

  if (!upstream) return json(502, { error: 'upstream_unreachable', fallback: true });
  if (!upstream.ok) {
    const quota = upstream.status === 429;
    return json(quota ? 429 : 502, {
      error: quota ? 'quota_exceeded' : 'upstream_error',
      status: upstream.status,
      fallback: true,
    });
  }

  // Convert Gemini SSE -> plain text chunks
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';

  function emit(line, ctrl) {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const d = JSON.parse(payload);
      const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (text) ctrl.enqueue(encoder.encode(text));
    } catch {
      /* ignore partial / non-JSON lines */
    }
  }

  const stream = upstream.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) emit(line, ctrl);
      },
      flush(ctrl) {
        if (buf) emit(buf, ctrl);
      },
    })
  );

  return new Response(stream, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-chat-mode': 'cloud',
    },
  });
}
