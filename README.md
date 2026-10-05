# AURA AI — v2

Free, public, ChatGPT-style assistant: home page → sign in → chat, with a sidebar of chats, rename, search, and projects.

| File | What it is |
|---|---|
| `index.html` | Home page, sign-in page and chat app (one page) |
| `style.css` | All styling (light + dark mode, mobile) |
| `app.js` | App logic: sign-in, chats, projects, sidebar, cloud + on-device AI |
| `firebase-config.js` | **You paste your Firebase config here** |
| `firestore.rules` | Security rules to paste into Firebase (each user sees only their own chats) |
| `api/chat.js` | Vercel server function: checks sign-in, calls Gemini |

Everything runs on free tiers: Vercel (hosting), Firebase Spark (sign-in + database), Gemini (AI).

## Demo mode
While `firebase-config.js` is empty, the app runs in demo mode: sign-in just asks for an email and chats are saved only in that browser. Useful for checking the site before Firebase is set up.

## Setup
1. **Firebase project** — console.firebase.google.com → Create project → add a Web app (`</>`) → copy the config.
2. **Authentication** → Get started → Sign-in method → enable **Google** and **Email/Password**. Then Settings → Authorized domains → add your `*.vercel.app` domain.
3. **Firestore Database** → Create database → production mode → Rules tab → paste `firestore.rules` → Publish.
4. **Vercel** → Settings → Environments → add `FIREBASE_PROJECT_ID` = your Firebase project ID (keep `GEMINI_API_KEY`).
5. **GitHub** → upload the files, edit `firebase-config.js` with your config, replace `api/chat.js`. Vercel redeploys automatically.

## Free-tier limits (approximate, check current pricing pages)
- Firestore Spark: ~20,000 writes/day → roughly 10,000 messages a day across all users.
- Gemini free tier: per-minute and per-day request caps; beyond that AURA switches to on-device mode.
- Each chat is stored as one document (max ~1 MB, roughly a few hundred long messages).

## Optional Vercel variables
`GEMINI_MODEL` (default `gemini-2.5-flash`), `SYSTEM_PROMPT`, `RATE_LIMIT` (default 30 requests per user per 10 min).
