// Vercel Edge Function: proxies chat to Google Gemini (free tier) and streams plain text back.
// Returns {fallback:true} on quota / rate-limit / outage so the browser can switch to the on-device model.

export const config = { runtime: 'edge' };

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || 'You are AURA AI, a helpful, friendly and concise assistant.';
const MAX_MSG_CHARS = 4000;        // per message
const MAX_HISTORY = 20;            // messages sent upstream
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20); // requests per IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;                    // 10 minutes

// Best-effort per-IP limiter (per edge instance). Protects your free quota from a single abuser.
const hits = new Map();
function isLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    if (hits.size > 5000) hits.clear(); // keep memory bounded
    return false;
  }
  h.count += 1;
  return h.count > RATE_LIMIT;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(503, { error: 'not_configured', fallback: true });

  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (isLimited(ip)) return json(429, { error: 'rate_limited', fallback: true });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_json' });
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
    return json(400, { error: 'no_user_message' });
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}` +
    `:streamGenerateContent?alt=sse`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
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
