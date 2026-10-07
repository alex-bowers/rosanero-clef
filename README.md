# Rosanero

A private, mobile-first web app that helps one person learn Italian through Palermo FC news. It runs entirely on Cloudflare. The point of this was to play with Clef.

A Clef decision model rates each chunk's difficulty (CEFR, A1 to C2) and scores the learner's translations. An LLM only writes text: the reference translation at ingest, and explanations on request. See [PLAN.md](PLAN.md) for the full design and milestones.

## Status

Milestones 1 to 6 are done: practice, result, explanations, history and settings all work in the browser. Milestone 7 (hardening) is mostly done: rate limits, daily caps, call logging and error handling are built, and the app has been deployed behind Cloudflare Access. See [DEPLOY.md](DEPLOY.md) for the deployment checklist.

Pressing **Fetch new sentences** on the Practice page starts a background job (a Cloudflare Workflow) that discovers articles on forzapalermo.it, splits them into chunks, rates each chunk's difficulty with Clef-flash, and stores a reference English translation from Mistral Small 3.1 (all via Workers AI). The page shows each step while it runs and the number of sentences added when it finishes. Once the daily sentence cap is reached the button rests until the next UTC day, unless some sentences still need rating or translating. Setting the cap to 0 pauses ingest, rating and translation. Otherwise the cap is soft: it is checked between articles, and an article is always stored whole. If the site's RSS feed fails, discovery falls back to its listing pages.

To try it locally: run `pnpm db:migrate:local`, start `pnpm dev`, open the dev URL and press **Fetch new sentences** (it takes a few minutes). The dev server makes real Workers AI calls.

The app has no sign-in of its own and every attempt spends Workers AI credits, so keep Cloudflare Access in front of every address it has.

## API

| Route | What it does |
|---|---|
| `GET /api/health` | Returns `{ "ok": true, "decisionModel": "..." }`. It does not call Workers AI or the database. |
| `GET /api/chunks/next` | A sentence at your target level and within your level range (both from settings), preferring ones you have not attempted. `?level=` and `?range=` override the settings. It never includes the reference translation. |
| `POST /api/attempt` with `{ "chunkId": 1, "attempt": "..." }` | Scores the attempt (up to 1,000 characters) with Clef, stores it, and returns the verdict, fluency (0 to 4), whether to offer an explanation, and the reference translation. |
| `POST /api/explain` with `{ "attemptId": 1 }` | Writes short feedback with the language model, only when asked. Each attempt is explained once; later requests return the stored text. |
| `GET /api/history?limit=20` | Recent attempts (1 to 50), newest first, with the reference and any explanation. |
| `GET /api/usage?days=7` | Requests used today against the daily limits, and for each purpose and model: calls, failures, median and 95th-percentile latency, and token counts (1 to 90 days). |
| `GET /api/settings`, `PUT /api/settings` | Read or change `targetLevel` (A1 to C2), `levelRange` (0 to 5) and `dailyChunkCap` (0 to 40). Send any subset. |

Errors are JSON of the form `{ "error": "..." }`: 400 for bad input, 404 for nothing matching, 413 for a request over 4 KB, 405 for the wrong method, 429 when a limit is reached (with a `Retry-After` header), 500 for an unexpected server error, and 502 if the scorer or the language model is unavailable.

## Prerequisites

- Node.js 22.18 or later (the tests run TypeScript directly).
- pnpm.
- A Cloudflare account with Workers AI enabled.

## Run the tests

No installation is needed. The tests use Node's built-in runner and the mock clients, so they make no network calls.

```sh
pnpm test
```

## Set up Cloudflare (owner steps)

1. Install the dependencies (Wrangler is the only one): `pnpm install`.
2. Sign in: `pnpm exec wrangler login`.
3. Create the database: `pnpm exec wrangler d1 create palermo-reader`.
4. Copy [wrangler.jsonc](wrangler.jsonc) to `wrangler.local.jsonc`, which is git-ignored. In the copy, replace `REPLACE_WITH_D1_DATABASE_ID` with the ID the previous command printed, and `app.example.com` with your own hostname. The `pnpm` scripts below use the local copy, so your real values are never committed.
5. Apply the schema locally: `pnpm db:migrate:local`.
6. Start the dev server: `pnpm dev`, then open `/api/health`.

## Limits and cost control

Attempts and explanations are limited so that a bug or a stray script cannot run up a bill. The values live in `vars` in [wrangler.jsonc](wrangler.jsonc):

| Setting | Default | Meaning |
|---|---|---|
| `ATTEMPTS_PER_MINUTE` | 10 | Translation attempts scored per minute |
| `EXPLAINS_PER_MINUTE` | 5 | New explanations written per minute |
| `DAILY_ATTEMPT_CAP` | 200 | Attempts per UTC day |
| `DAILY_EXPLAIN_CAP` | 50 | New explanations per UTC day |

Invalid requests and stored explanations do not count. A request that fails at the AI service does count, because it may have cost something. New sentences per day are capped separately on the Settings page. Every Workers AI call is recorded (purpose, model, duration, tokens), and `/api/usage` summarises it.

## Install on a phone

The app can be added to a home screen. On iPhone, open it in Safari, tap Share, then Add to Home Screen. On Android, open it in Chrome and tap Install app in the menu. Sign in through Access once inside the installed app.

The eagle in `design/eagle.svg` is the source for the favicon, the home screen icons and the iPhone splash screens. Each PNG in `public/icons` is rendered straight from it at its final size, so none is blurred by scaling. After changing the eagle, run `pnpm icons` and commit the results.

## Database migrations

Migrations live in `migrations/`. `0002_settings_range.sql` adds the level range setting and `0003_usage.sql` adds the request and AI call logs. Both are applied to the local and remote databases (the remote one holds the schema and no data). Apply future migrations with `pnpm db:migrate:local` and `pnpm db:migrate:remote`.

## Rating calibration

Clef rates each chunk's CEFR level, and the app shows that rating. Check how far to trust it:

1. Open `evals/cefr-calibration.json` (not committed, because it holds article text) and set `label` to `A1`–`C2` for each chunk you can grade. Aim for about 40.
2. Start the dev-only proxy in one terminal: `pnpm eval:proxy`. It makes Workers AI calls, which are billed to your account, and must never be deployed.
3. In another terminal run `pnpm eval:cefr`. Set `MODEL=@cf/cloudflare/clef` to try the larger model.

The report gives accuracy, accuracy within one level, a confusion matrix, and whether "N% confident" is right about N% of the time. `evals/smoke-cefr.json` holds 7 synthetic sentences for checking the runner. Their labels are the author's judgement, not ground truth.

## Scoring calibration

The same proxy setup checks how well Clef scores translation attempts. `evals/scoring-calibration.json` (not committed, because it holds article text) holds (Italian, reference, attempt) examples. Its `label` values (`fully_correct`, `minor_issue`, `partly_correct`, `wrong`) are a **draft** written by the author. Review and correct them, then run `pnpm eval:scoring` with `pnpm eval:proxy` running. It uses `@cf/cloudflare/clef`, as production does. Set `MODEL=@cf/cloudflare/clef-flash` to compare the smaller model.

The report adds two checks: how often an attempt is judged acceptable versus not, and how often the verdict changes when the attempt is typed in lower case with no punctuation, as on a phone.

## Configuration

Non-secret settings live in `vars` in [wrangler.jsonc](wrangler.jsonc):

| Setting | Default | Meaning |
|---|---|---|
| `DECISION_MODEL` | `@cf/cloudflare/clef-flash` | Clef model that rates each chunk's difficulty at ingest |
| `SCORING_MODEL` | `@cf/cloudflare/clef` | Clef model that scores translation attempts |
| `LLM_MODEL` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Model that writes reference translations and explanations |
| `CONFIDENCE_THRESHOLD` | 0.45 | The Explain button also appears when the scorer's confidence is below this |

The request limits are described under [Limits and cost control](#limits-and-cost-control). The target level, level range and daily sentence cap are not in `vars`: they are stored in the database and changed on the Settings page. Secrets, if any are ever needed, go in with `wrangler secret put` and are never committed.
