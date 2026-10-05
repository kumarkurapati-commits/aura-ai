# AURA AI — free hybrid chatbot

A public ChatGPT-style chatbot that costs nothing to run.

- **Cloud mode:** answers come from Google Gemini's free tier through a Vercel function (your API key stays on the server).
- **On-device mode:** when the free quota or rate limit is hit, the page automatically switches to a small open model (Llama 3.2 1B) that runs inside the visitor's own browser via WebLLM. It retries the cloud after 5 minutes.

```
index.html      the chat page (no build step)
api/chat.js     Vercel Edge Function: rate limit + Gemini streaming proxy
```

## Deploy in about 15 minutes

1. **Get a free Gemini API key** at https://aistudio.google.com/apikey (sign in with Google → "Create API key").
2. **Put the code on GitHub:** create a new repository and upload `index.html` and the `api` folder (keep the folder structure).
3. **Deploy on Vercel:** sign up free at https://vercel.com with GitHub → "Add New… → Project" → import the repository → leave all settings as default.
4. **Add the key:** in the Vercel project go to Settings → Environment Variables → add `GEMINI_API_KEY` = your key → then Deployments → "Redeploy".
5. Open `https://<your-project>.vercel.app` and share the link.

### Optional settings (Vercel environment variables)

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.5-flash` | Which Gemini model to call. Check Google AI Studio for the current free-tier models. |
| `SYSTEM_PROMPT` | helpful, concise assistant | The bot's personality and instructions. |
| `RATE_LIMIT` | `20` | Max requests per visitor IP per 10 minutes. |

To change the on-device model, edit `LOCAL_MODEL` near the top of the script in `index.html`.

## Test locally

```
npm i -g vercel
vercel dev
```
Create a `.env.local` file containing `GEMINI_API_KEY=your-key` first. If you open `index.html` without the function running, the page goes straight to on-device mode — a handy way to test the fallback.

## Limits to know

- **Free-tier quota:** Gemini's free tier has per-minute and per-day request limits (they change; see AI Studio). Beyond that, visitors are moved to on-device mode.
- **Data:** on Google's free tier, prompts may be used to improve Google's products. State this in your site's privacy notice, or move to the paid tier if that matters.
- **On-device mode** needs a WebGPU browser (recent Chrome/Edge on desktop and Android; Safari support is newer) and a one-time ~0.9 GB download. Answers are weaker than Gemini's.
- **Rate limiter** is best-effort per server instance. If you get abused, add Cloudflare Turnstile (free CAPTCHA) or Vercel's firewall rules.
- **Chat history** lives only in the open tab; refreshing clears it. Nothing is stored on your server.
