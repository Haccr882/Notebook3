# Notebook — AI Study Notes, Specimen Papers & Doubt Chat

## What's inside

```
notebook/
├── index.html                ← the website (Notes/Paper + Doubt Chat modes, PDF, help/feedback)
├── vercel.json                ← server timeout config (60s, Vercel's max on free plan)
├── api/
│   ├── providers.js              ← ONE shared module that calls every AI provider + fallback chain
│   ├── _limits.js                 ← shared rate-limit / premium-token helpers (not a route)
│   ├── generate.js                ← multi-agent notes/paper backend (plan → parallel sections)
│   ├── chat.js                     ← doubt-solving chat backend (separate from generate.js)
│   ├── redeem.js                    ← premium code redemption
│   └── feedback.js                   ← stores user feedback (readable via admin secret)
├── pages/
│   └── premium.html                ← premium redeem page
└── docs/
    └── UPSTASH-SETUP.md              ← real per-IP rate limiting setup
```

## Two separate modes

The app now has a mode switch at the top of the chat:

- **📝 Notes/Paper** — the original multi-agent pipeline: plans a document
  structure, then writes every section in parallel, then assembles &
  verifies it, ready to download as a PDF.
- **💬 Doubt Chat** — a plain, stateful conversation for quick questions.
  It NEVER touches the plan/section/PDF pipeline, so a doubt never
  accidentally turns into a document. Separate daily quota, separate
  backend endpoint (`api/chat.js`).

## Multi-provider AI with automatic fallback

`api/providers.js` is the one place that knows how to call every AI
provider. Both `generate.js` and `chat.js` hand it a **chain** of
provider names and it tries them in order until one succeeds — a provider
whose API key isn't set is skipped (not treated as a failure), so the app
works fine even with only 1-2 keys configured.

| Provider | Env var | Model (default, overridable) | Notes |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/free` | Primary, free tier |
| Grok (xAI) | `XAI_API_KEY` | `grok-2-latest` | Used for both notes/paper generation and chat |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | Very fast; **Groq deprecated `llama-3.3-70b-versatile` on 16 Aug 2026** — this 120B model is their official replacement, and has its own daily call cap (see below) to protect the shared key |
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` | Stable backup; different request shape, handled internally |
| NVIDIA | `NVIDIA_API_KEY` | `nvidia/nemotron-3-ultra-550b-a55b` | Last-resort fallback |
| OpenRouter (fallback model) | (same key) | `meta-llama/llama-3.3-70b-instruct:free` | Final safety net for notes/paper generation |

Chains used:
- **Notes/Paper** (plan + each section): OpenRouter → Grok → Groq → Gemini → NVIDIA → OpenRouter-fallback.
- **Doubt Chat**: Grok → Groq → Gemini → OpenRouter.

All providers share ONE total time budget per request (`TOTAL_CHAIN_BUDGET_MS`
in `providers.js`) so trying several of them can never blow past Vercel's
60-second function limit.

### Groq gpt-oss-120b daily call cap

Because it's a bigger/pricier model with a tighter free-tier quota, calls to
it are also checked against a shared, app-wide daily counter
(`GROQ_120B_DAILY_LIMIT`, default 1000) — separate from any per-student
limit. If the app-wide cap is hit, that one call just falls through to the
next provider in the chain; it doesn't fail the request.

## How the notes/paper generation works (multi-agent)

1. **Plan agent** — one fast call decides the document's structure: how
   many sections it genuinely needs for the topic (no fixed page count —
   a narrow topic gets fewer, short sections; a broad one gets more), and
   for specimen papers, the exact mark scheme based on real CBSE/ICSE
   board patterns. Notes sections are limited to Overview, Key Concepts,
   Important Definitions, Formulas/Laws, Worked Examples, and Quick
   Revision Summary — no "Common Mistakes"/"Exam Tips" filler sections.
2. **Section agents** — every section is written in **parallel**, not one
   after another, so a 15-section paper takes about as long as one section.
3. **Verification & retry** — each section is checked for actually
   containing every question it was assigned (not just "the AI said it's
   done"). Up to 3 frontend-level attempts are made, and each attempt
   already runs the FULL server-side provider chain above — so a section
   is only given up on after exhausting many independent provider/attempt
   combinations. The most complete attempt is kept even if none are
   perfect, and a repair pass (with the rest of the document as context)
   runs afterward for anything still incomplete.
4. **Assembly** — numbering is assigned by the code, never trusted from
   the AI, eliminating numbering bugs entirely.

## Topper-notes-style PDF formatting

Every section gets its own colour from a 7-colour palette (matched by
heading keyword first — Formulas is always purple, Worked Examples always
teal — falling back to cycling by position), a numbered badge in that
colour, and anchor sections (Overview, Quick Revision Summary) get a
bigger heading plus a soft highlighted box. Formula-looking lines get a
coloured box matching their section. A gradient strip across the top
samples every colour actually used in the document. The exact same markup
is used for the on-screen bubble and the downloaded PDF (via the browser's
native print-to-PDF), so what the student sees is exactly what they get.

## Deploy steps

1. **GitHub**: create a repo, upload this entire `notebook/` folder's
   contents to the repo ROOT (not inside a subfolder).
2. **Vercel**: New Project → connect the repo → Deploy.
3. **Environment variables** (Vercel → Settings → Environment Variables):
   - `OPENROUTER_API_KEY` — from openrouter.ai/keys
   - `XAI_API_KEY` — from console.x.ai (Grok)
   - `GROQ_API_KEY` — from console.groq.com
   - `GEMINI_API_KEY` — from aistudio.google.com/apikey
   - `NVIDIA_API_KEY` — from build.nvidia.com (optional but recommended)
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — optional, for
     real per-IP daily limits (see docs/UPSTASH-SETUP.md) and the Groq
     120B daily cap; without these, limits still "work" but are easier to
     bypass and the 120B cap is skipped entirely
   - `ADMIN_SECRET` — only needed for redeem.js/feedback.js's admin actions
   - Optional overrides: `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`,
     `GROQ_MODEL`, `GEMINI_MODEL`, `XAI_MODEL`, `NVIDIA_MODEL`,
     `GROQ_120B_DAILY_LIMIT`
   - None of these are required for the app to run — any missing key just
     means that provider is skipped in the fallback chain. At minimum,
     set `OPENROUTER_API_KEY` to have a working app.
4. Redeploy after adding environment variables (they only apply to new
   deployments).

## Daily limits

- **Notes/Paper**: 5/day free, 10/day Premium.
- **Doubt Chat**: 20/day free, 60/day Premium.
- These are tracked completely separately (different Upstash key prefixes),
  so using up one doesn't affect the other.

## Turning on Premium later

The redeem-code system (`api/redeem.js`, `pages/premium.html`) is fully
built but not linked from the main site — everything above is free for
now, as requested. To turn it on:
1. Add `ADMIN_SECRET` to Vercel if not already there.
2. Generate a code by POSTing `{"action":"generate","adminSecret":"..."}`
   to `/api/redeem`.
3. Send the code to whoever paid; they redeem it at `/pages/premium.html`.
4. Link to `/pages/premium.html` from the main site's sidebar when ready.

## Login / Google sign-in

Not part of this build — noted as a separate, later step (Google
OAuth/sign-up) to be added on top of the current per-device (localStorage)
system once you're ready for it.

## Turning on ads later

`index.html` already has an ad slot ready (`#adSlot`, currently hidden).
Once you have an AdSense account, paste your ad unit code inside that div
and change its CSS `display: none` to `display: block`.

## Testing note

This sandbox has no live internet access, so the multi-provider fallback
logic, rate limiting, and both API endpoints were verified with syntax
checks and mocked HTTP responses (missing-key skip, provider failure →
fallback, Gemini's different request/response shape, the Groq 120B daily
cap correctly falling through) rather than real calls to Grok/Groq/Gemini.
Do one real end-to-end test after adding your API keys to Vercel.
