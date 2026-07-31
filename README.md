# open-editor-backend

A **standalone** backend for Open Editor (its own project, a sibling of
`open-editor` and `open-editor-web` — NOT part of the editor's pnpm workspace).
The editor talks to it only via a runtime `aiEndpoint` URL; there is no build-do chec
time coupling.

**Phase A (now): a secure AI proxy** so the editor's AI features (Translate,
Quick Actions, Chat, Review) produce **real** output without ever exposing an
API key to the browser. Built with NestJS. Installed/run with **npm** (fully
self-contained `node_modules`).

> Later phases (planned): licensing/admin — an admin panel to create feature
> packages, set prices, and mint the ES256-signed license tokens the editor
> already verifies. Stack: **NestJS + MySQL + TypeORM**.

## Why a backend at all?

The editor is *bring-your-own-endpoint*: the browser POSTs `{ prompt, system }`
to an `aiEndpoint` and streams the reply. It ships with **no AI key** on
purpose — because **any key placed in browser code is public** (DevTools, the
JS bundle). The only secure design is:

```
Browser (editor)  ──POST /api/ai──►  THIS backend  ──►  Groq / OpenAI / …
   no key                            holds the key        the model
```

The key lives in the server's environment and is attached only on the
server→provider hop. The browser only ever talks to this backend.

## Run it (free, with Groq)

This is a standalone project — run it from **its own folder** with npm:

```bash
cd open-editor-backend

# 1) get a free key at https://console.groq.com/keys
cp .env.example .env
#    → set GROQ_API_KEY=...

# 2) install + start
npm install
npm run start:dev          # http://localhost:8787  (PORT env to change)

# 3) point the editor at it (in your editor app / playground config)
#    new OpenEditor(el, { aiEndpoint: 'http://localhost:8787/api/ai' })
```

Now selecting text → **Translate → Japanese** returns a real translation (兄),
not a placeholder.

> Note the port: the server listens on **8787** by default (set `PORT` to
> change). Make sure the editor's `aiEndpoint` and this port match, and that the
> editor's origin is listed in `AI_CORS_ORIGINS`.

## Endpoints

- `POST /api/ai` — body `{ prompt: string, system?: string }`. Streams an
  OpenAI-shaped SSE response (`data: {choices:[{delta:{content}}]}` … `[DONE]`),
  which the editor's `aiComplete()` reads natively. `GET /api/ai/health` is a
  readiness probe.
- `GET /health` — structured health for all subsystems (database + AI), e.g.
  `{ status, checks: { database: {status}, ai: {status} } }`.

## Database (optional — for licensing/admin, Phase C+)

MySQL via TypeORM, but **off by default** and **not required by the AI proxy**.
Set `DB_ENABLED=true` + `DB_*` creds in `.env` to enable it. With it off the app
still boots and AI works; `/health` reports `database: disabled`. Schema is
managed by migrations: `npm run migration:generate` / `migration:run`
(`synchronize` is dev-only). See `ROADMAP.md` for the full licensing plan.

## Security properties

- **Key isolation** — read from `process.env` (`GROQ_API_KEY`/`AI_API_KEY`);
  never returned, logged, or sent to the browser.
- **Input validation** — non-empty `prompt`, capped at `AI_MAX_PROMPT_CHARS`.
- **No client-controlled provider params** — only `prompt`/`system` are
  forwarded; the model, key, and stream flag are fixed server-side, so a client
  can't inject its own model or params.
- **CORS allowlist** — only origins in `AI_CORS_ORIGINS` may call it from a
  browser.
- **Abort on disconnect** — if the browser closes, the upstream call is aborted
  (no wasted tokens).
- **Sanitized errors** — provider error bodies are not forwarded; a missing key
  yields a clear `503`, never a leak.

## Switching to a paid provider later

Groq is OpenAI-compatible, so any OpenAI-style gateway works: change
`AI_BASE_URL`, `AI_MODEL`, and the key. No code change.
