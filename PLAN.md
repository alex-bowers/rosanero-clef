# Project plan: Palermo Italian Reader (working title)

## 1. What we're building

A private, mobile-first web app, hosted entirely on Cloudflare, that helps one person (the owner) learn Italian through Palermo FC news.

The loop:
1. A background job, started from a button in the app, pulls recent articles from https://forzapalermo.it/ and splits them into small chunks (1-3 sentences).
2. A **Clef** decision model rates each chunk on the CEFR scale (A1-C2) with a probability distribution.
3. An **LLM** writes a reference English translation once, at ingest time, and it is stored.
4. In the app, the user sees an Italian chunk plus its CEFR rating, types their own English translation, and gets scored.
5. If they score poorly (or the scorer is unsure), they can tap to get an LLM explanation.

**Why this design:** the project exists to show off how a decision model works. Clef makes two fast, bounded decisions (rate difficulty, judge a translation) and returns calibrated probabilities. The LLM is used only where text must be generated (translate once, explain on demand). Keep that separation clean; it is the point of the project.

## 2. Decisions already made (don't relitigate)

- Hosting: all Cloudflare (Workers, D1, Workflows, Workers AI, static assets). Used on a phone, so mobile-first.
- Decision model: **Clef-flash** (9B) by default, **Clef** (27B) configurable. Cloudflare's Clef is Jev-API compatible, so the decision client must sit behind an interface that could be pointed at Jev later.
- Single user, private. Protect with Cloudflare Access (or a simple shared secret as a fallback). No public sign-up.
- The Claude Code subscription CANNOT be used here (hosted app). The LLM is either a Workers AI open-weight model or the Anthropic API with an API key, behind an interface.
- Source content is a commercial news site. Do NOT republish articles. Store only chunks needed for practice, always keep and show a link to the original article, keep the app private. Check the site's robots.txt and be polite (low rate, identifiable User-Agent, cache).

## 3. Things to VERIFY before relying on them (do not guess)

I (the planner) could not test any of this live. Confirm from current docs or by a real call, and tell the owner what you found:

- Clef on Workers AI: model IDs appear to be `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`. Check the Workers AI model catalog page for the exact input/output schema, and whether the `env.AI` binding accepts the System One request shape or only the REST endpoint does.
- Reported System One protocol details (verify): the request is a `state` plus a map of typed questions (`noul`, `choice`, `score`); every question needs `instructions`; 1-64 questions per call; Choice has 2-255 options; Score has 2-10 levels; one probability distribution is returned per question, rounded to 4 decimals; REST responses are wrapped in `{result, success, errors, messages}`.
- Cold start: the first request to a cold Clef model can take close to a minute. Use generous timeouts, run ingest in the background, and never put a cold call in the user's path if avoidable.
- Pricing: hosted Clef is billed per input token (reported around $0.09/M for clef-flash and $0.24/M for clef; output not billed). Confirm.
- Which Workers AI text model translates Italian to English well. Pick from the catalog, run a small sample, and show the owner the output before committing.
- Whether forzapalermo.it exposes usable RSS. The footer links to https://forzapalermo.it/rss-feeds. Check what feeds exist and whether they carry full text or only excerpts. If excerpts only, fetch each article page and extract the body with HTMLRewriter.
- Run `wrangler` and check the latest config format (`wrangler.jsonc`) and compatibility date.

### Verification results (3 October 2026, real calls through the `env.AI` binding)

- **Verified:** `env.AI.run("@cf/cloudflare/clef-flash" | "@cf/cloudflare/clef", { state, questions })` works. The binding returns the result unwrapped (no `{result, success, errors, messages}`), and `model` is not needed in the input despite the docs listing it.
- **Choice:** `criteria` is a map of option to description. Answer: `{ type, choice, probabilities: { label: p }, confidence }`. At least 2 options (enforced).
- **Score:** `criteria` is an array of level descriptions, at least 2 (enforced). Levels are 0-indexed. Answer: `{ type, score, legend, probabilities: { "0": p, … }, confidence }`, where `score` is the probability-weighted mean.
- **Noul:** answer is `{ type, noul: p }`, a bare probability.
- **Usage:** `usage.output_tokens` is 0, which is consistent with input-only billing.
- **Cold start:** the first call took about 1 s (one sample). The plan's "close to a minute" warning did not occur, but keep generous timeouts.
- **Calibration warning:** distributions are flat (a typical B1 call was about 45%). Gating thresholds must be tuned on the calibration sets.
- **Undocumented `confidence` field:** it is not the top probability. Do not use it; derive confidence from `probabilities`.
- **Not yet verified:** the 255-option and 10-level upper limits, the REST wrapper, and the clef-flash price (the $0.24/M figure for clef is from the docs only).
- **Remote D1:** `palermo-reader` has the migration applied.

### Calibration results (4 October 2026, 28 chunks graded by the owner: 6 B1, 15 B2, 7 C1)

| | Clef-flash (9B) | Clef (27B) |
|---|---|---|
| Exact level | 43% | 29% |
| Within one level | 93% | 82% |
| Mean absolute error | 0.57 levels | 0.64 levels |
| Calibration error | 0.06 | 0.19 |
| Time for 28 chunks | 8.3 s | 13.5 s |

- **Decision: rate with Clef-flash.** It was better on every measure, faster and cheaper. (On 7 synthetic sentences the 27B model looked better, so the evidence is thin either way: small samples, one grader.)
- **Neither model ever predicts C1**, and both call most B2 text B1. Treat the top label as a lower bound.
- **Use the expected level as a relative difficulty score, not as an absolute CEFR label.** Flash ranks 72% of chunk pairs correctly (chance is 50%), with means rising from B1 (2.36) to B2 (2.70) to C1 (2.79), but B2 and C1 are barely separated.
- **Flash's confidence is honest but low** (36–45% in both bins, with accuracy 44% and 42%).
- Re-run `pnpm eval:cefr` when the calibration set grows.

### Scoring calibration (4 October 2026, 40 examples: 10 chunks × 4 attempts, labels reviewed by the owner)

The owner changed 3 of the planner’s 40 draft labels (two reversed-meaning attempts to `wrong`, and one dropped-word attempt to `partly_correct`). Final label counts: 10 fully correct, 9 minor issue, 9 partly correct, 12 wrong.

| | Clef-flash (9B) | Clef (27B) |
|---|---|---|
| Exact verdict | 35% | 60% |
| Acceptable (fully/minor) vs not (partly/wrong) | 68% | **98%** |
| Within one step | 68% | 98% |
| Calibration error | 0.19 | 0.06 |
| Acceptable/not changed when typed lower case, no punctuation | 2/40 | 4/40 |
| ...after `tidyAttempt` (capital first letter, final full stop) | 0/40 | 1/40 |
| Time for 40 items (3 scorings each, 2 calls per scoring) | 38.0 s | 61.9 s |

- **Decision: score with the 27B model** (`SCORING_MODEL`); rating stays on flash. Flash is too lenient: it passed 9 of 9 partly-correct attempts and 7 of 9 minor-issue attempts as fully correct.
- **27B made one acceptable/unacceptable error in 40** (a partly-correct attempt called fully correct). Most other errors are between neighbouring verdicts: 10 of 12 wrong answers came out as partly correct, and fully correct and minor issue are mixed (5 of 19). Both of those already trigger or allow Explain.
- **27B is well calibrated:** confidence 60–80% was right 70% of the time (mean confidence 70%); 40–60% was right 57% (mean 49%).
- **Typed on a phone:** lower case with no punctuation moved 4 attempts across the acceptable line. `tidyAttempt` (src/normalise.ts) cuts that to 1. **Apply it before scoring.**
- **Confidence threshold 0.45** (was 0.6): Explain shows on 4 of 19 acceptable answers and on all 21 unacceptable ones; at 0.6 it showed on 16 of 19.
- Not yet checked: the effect of a wrong reference translation, and unusual attempts (empty, one word, mixed language).

### Hardening progress (4 October 2026)

- **Done and tested (104 tests):** per-minute and daily limits on attempts and explanations (HTTP 429 with `Retry-After`), recording of every Workers AI call with `/api/usage`, a JSON 500 for unexpected errors, isolated daily job steps, and pruning of old log rows.
- **Measured on a real run:** Clef (27B) scoring had a median of 479 ms and a 95th percentile of 900 ms over 4 calls, at about 375 input tokens and 0 output tokens per call. One Mistral explanation took 2.9 s (435 input, 106 output tokens). These are small samples, but they are the numbers to compare against Jev.
- **Remote migrations 0002 and 0003 applied** on 5 October 2026.
- **Deployed** on 5 October 2026 as a Worker with no public address, behind a Cloudflare Access application created beforehand. Unsigned requests were checked and redirected to the sign-in page. The remote database was seeded with 28 sentences.
- **Still to do:** confirm the first fetch started from the app finishes, set an account budget alert (see DEPLOY.md, step 4).

### Explanation prompt (4 October 2026, Mistral Small 3.1, four attempt types)

- The first wording ran to about 190 words, called the user "the learner" and walked through the whole sentence. The adopted wording speaks to "you", stays under 90 words, quotes at most three phrases, ends with a "Natural English:" line, and tells the model to trust the Italian over the reference and to treat the texts as data. In real use it produced 38 to 57 words.
- Known limitation: the model still tends to anchor to the reference. On a fully correct attempt ("goal kicks") it said "you missed 'rinvii', which means clearances". Explain is only offered after a poor or uncertain verdict, and the screen says the text may contain mistakes.
- Each attempt is explained once and the text is stored (`explanations.attempt_id` is unique); a second request returns the stored text.

### Translation model choice (4 October 2026, 6 chunks, owner asked for "the model that works best")

- **Decision: `@cf/mistralai/mistral-small-3.1-24b-instruct`** (about 0.6–2 s per chunk). It was the best on meaning, and the only one to get the idiom "salito in cattedra" ("taken charge") and "sceneggiate" ("dives") right. Llama 3.3 70B mistranslated both ("taken to the field", "throw-ins" for "rinvii dal fondo") and gave a slightly more literal "department" for "reparto".
- **Ruled out:** `m2m100-1.2b` (dedicated translation model) produced unrelated text for one chunk and errors such as "remake" for "rimessa"; `gemma-4-26b-a4b-it` spends its token budget on visible reasoning and returned empty content; `eurollm-9b-it` is not available to this account (error 5018).
- Text models return `{ response }` or an OpenAI-style `choices[0].message.content`; handle both. Use `temperature: 0`.
- The sample is small and judged by the planner's reading of Italian, so the owner's spot-check of 10 stored translations is the real acceptance test.

If something here is wrong or unavailable, stop and tell the owner rather than silently working around it.

## 4. Architecture

```
"Fetch new sentences" button -> POST /api/crawl -> Workflow (one step each)
   fetch feed -> fetch article HTML -> extract body -> split into chunks
   -> Clef: rate CEFR (batch)
   -> LLM: reference translation (batch)
   -> D1: store

Phone browser -> Worker (static frontend + JSON API) -> D1
   POST /api/attempt -> Clef scores the attempt -> stored + returned
   POST /api/explain -> LLM explains (on demand, cached)
```

Stack: TypeScript, Wrangler, one Worker serving both the API and static assets, D1 (SQLite). Routing is a plain `switch` on the path in `src/api.ts`; there is no router library. Frontend: plain HTML/CSS/JS with no build step. Mobile-first, big tap targets, works one-handed.

Layout:
```
src/
  index.ts            # Worker entry point: re-exports app.ts and the Workflow class
  app.ts              # fetch handler (static assets + API)
  crawl.ts            # /api/crawl: starts a fetch, reports its progress, applies the daily cap
  daily.ts            # the fetch's steps: ingest, rating, translation, cleanup
  workflow.ts         # the Cloudflare Workflow that runs those steps in the background
  api.ts              # routes, validation, rate limits, usage summary
  db.ts               # D1 queries (one D1Store implementing every store interface)
  jobs.ts             # runs the daily steps so one failure does not stop the rest
  pending.ts          # shared loop for rating and translation (stops after 3 failures in a row)
  async.ts            # sleep and withTimeout
  metering.ts         # times and reports every Workers AI call
  rating.ts           # CEFR levels, prompts and summary maths
  rate.ts             # daily rating step
  translate.ts        # daily translation step
  scoring.ts          # translation scoring prompts and gating
  normalise.ts        # tidyAttempt
  types.ts            # DecisionClient, LlmClient, Env and D1 types
  ingest/             # discover.ts, fetch.ts, sources.ts, html.ts, chunk.ts, run.ts
  decision/           # clef.ts, mock.ts
  llm/                # workersai.ts, mock.ts
  eval/               # calibration.ts (metrics used by the eval scripts)
public/               # index.html, app.js, style.css, _headers
migrations/           # D1 SQL migrations (0001 to 0003)
evals/                # calibration runners, smoke set, dev-only AI proxy
test/
```

## 5. Data model (D1)

- `articles`: id, url (unique), title, published_at, fetched_at, content_hash
- `chunks`: id, article_id, position, italian_text, word_count, heuristics_json, cefr_probs_json (full distribution), cefr_expected (numeric, probability-weighted), cefr_top (label), cefr_confidence, reference_en, translated_at
- `attempts`: id, chunk_id, attempt_text, verdict_probs_json, verdict_top, fluency_score, confidence, needs_explanation (bool), created_at
- `explanations`: id, attempt_id, text, model, created_at
- `settings`: single row (target_level, daily_chunk_cap, level_range; `level_range` was added in migration 0002)
- `request_log`: id, route, at. One row per accepted attempt or explain request, used for the rate limits (migration 0003; rows older than 2 days are pruned)
- `ai_calls`: id, at, purpose, model, ok, duration_ms, input_tokens, output_tokens. One row per Workers AI call, used by `/api/usage` (migration 0003; rows older than 90 days are pruned)

Dedupe articles by URL and content hash. Use migrations, not ad hoc schema changes.

## 6. Pipeline details

**Ingest (on demand, from the Fetch new sentences button):**
- Respect a daily cap (default 20 new chunks) to control cost.
- Extract article body text only (no nav, ads, comments). Skip purely boilerplate pages.
- Sentence-split with `Intl.Segmenter('it', { granularity: 'sentence' })`. Group into chunks of 1-3 sentences, roughly 15-60 words. Drop chunks that are mostly a quote with no context, lists of names, or boilerplate.
- Heuristics stored alongside the model rating as a sanity check: word count, sentence count, mean sentence length and mean word length. A share of rare words was planned but not built.
- Discovery reads the RSS feed first. On 3 October 2026 the feeds returned HTTP 500, so the listing pages are the fallback. Pages are fetched one at a time, 3 seconds apart (the site's `Crawl-delay`), with an identifiable User-Agent, and at most 15 articles are inspected per run. The daily cap is soft: it is checked between articles and an article is always stored whole.
- Rating and translation are separate steps that run after ingest in the same fetch, one chunk per call (up to 100 pending chunks per run). A failed chunk is retried by the next run, and three failures in a row stop the step. Clef calls are not batched.

**CEFR rating (Clef, Choice question):**
- Options: A1, A2, B1, B2, C1, C2. Write clear `instructions` describing the task: rate the reading difficulty of this Italian text for an English-speaking learner.
- Store the full probability distribution. Compute an expected level (probability-weighted). Surface this in the UI as e.g. "B1 (62%), could be B2".
- Football journalism skews hard. The UI must let the owner filter by a target level and see a chunk's rating before attempting it.

**Reference translation (LLM):**
- Written by the fetch's translation step after ingest, stored in `chunks.reference_en`, hidden from the UI until after the attempt. A chunk is only offered for practice once it has a translation.
- Prompt for a faithful, natural English translation. Keep output plain text only.

**Scoring an attempt (Clef):**
- State: `{ italian, reference, attempt }`.
- Choice ("meaning"): fully_correct, minor_issue, partly_correct, wrong.
- Score ("fluency"): 5 levels, 0 to 4.
- These are two Clef calls made in parallel (one question each), using `SCORING_MODEL`. The attempt goes through `tidyAttempt` first.
- Instruct the model that valid alternative phrasings should be accepted if the meaning is preserved (the reference is one acceptable translation, not the only one).
- Gating: if top probability is below a configurable threshold (`CONFIDENCE_THRESHOLD`, 0.45), OR verdict is partly_correct/wrong, set `needs_explanation` and show an "Explain" button. Never auto-call the LLM; the user taps.
- Return to the UI: verdict, confidence, fluency, and the reference translation.

**Explain (LLM, on demand):**
- Input: Italian, reference, user's attempt, Clef verdict. Output: short, concrete feedback in English that points out vocabulary/grammar the learner missed and gives the idiomatic translation. Cache in `explanations`.

## 7. Provider interfaces

```ts
interface DecisionClient {
  choice(opts: { state: unknown; instructions: string; options: string[]; descriptions?: Record<string, string> }): Promise<Distribution>;
  score(opts: { state: unknown; instructions: string; levels: number; descriptions?: string[] }): Promise<Distribution>;
}
interface LlmClient {
  translate(it: string[]): Promise<string[]>;
  explain(input: ExplainInput): Promise<string>;
}
```

- `ClefClient` uses the `env.AI` binding only. The REST transport was not needed. It retries (twice by default, with backoff) except on `invalid_request` errors, and times out each call.
- `WorkersAiLlmClient` is the only LLM client. There is no Anthropic client.
- Implement `MockDecisionClient` and `MockLlmClient` for tests and local dev with no network.
- Config lives in `wrangler.jsonc` vars (models, confidence threshold, request limits) and D1 settings (target level, level range, daily sentence cap), not hardcoded. Each limit falls back to a built-in default if its var is missing or invalid.

## 8. Frontend (mobile-first)

Screens:
1. **Practice:** shows a chunk (Italian), its CEFR rating with confidence, link to the source article, a text box for the translation, Submit.
2. **Result:** verdict + confidence, fluency, the reference translation, an "Explain" button when `needs_explanation`.
3. **Settings:** target level, a "next chunk" filter (the level range, offered as the target level only, within one level or within two levels) and the daily sentence cap.
4. **History:** past attempts and scores (simple list is enough).

Show the probability distribution visually (a small bar for the CEFR rating) since showing how the decision model works is the point of the app. Keep it fast and uncluttered.

Colour scheme: Palermo FC's pink and black, but not too dark. Use a sans-serif font for Italian text and a serif font for English text. Make it accessible.

## 9. Testing and calibration

- Unit tests with the mocks for chunking, CEFR expected-level math, gating logic, and API routes.
- **Calibration sets** in `evals/`: ~40 Italian chunks the owner has graded by level, and ~40 (italian, reference, attempt, true_verdict) examples including valid paraphrases and clear errors. A script reports accuracy and calibration (is a "70% confident" call right ~70% of the time?). Run it against real Clef once deployed and report numbers honestly. The owner will fill in labels; generate unlabelled templates for them.
- Include a robustness check: the same decision should not flip when harmless surrounding context is added. Built so far: the scoring eval checks whether the verdict changes when the attempt is typed in lower case with no punctuation. Adding harmless surrounding context was not built.

## 10. Milestones (stop and report after each)

Status on 5 October 2026: milestones 1 to 6 are done. Milestone 7 is mostly done (see "Hardening progress" in section 3 for what remains).

1. **Scaffold:** repo, wrangler config, D1 migrations, mocks, test runner, README with setup steps. Acceptance: tests pass locally with mocks.
2. **Ingest:** feed + article extraction + chunking, run against real pages. Acceptance: shows 20 sample chunks to the owner.
3. **Rating:** Clef CEFR rating wired in (mock first, then real). Acceptance: rating table for the sample chunks, plus calibration script run.
4. **Translation:** reference translations stored. Acceptance: owner spot-checks 10.
5. **Practice loop + scoring:** API and frontend working end to end on a phone. Acceptance: owner completes 5 attempts.
6. **Explain + history + polish:** on-demand explanation, caching, settings. Acceptance: demo of a poor score leading to an explanation.
7. **Hardening:** Cloudflare Access, rate limits, cost caps, error handling, logging of Clef latency and cost per call (useful for the comparison with Jev).

## 11. Steps only the owner can do (ask when you reach them)

- `wrangler login`, create the D1 database, put the database ID in config.
- Add secrets with `wrangler secret put` if any are ever needed (none are, because the LLM is a Workers AI model; never commit secrets).
- Enable Workers AI on the account and confirm Clef access.
- Set up Cloudflare Access for the app's URL.
- Label the calibration sets.

## 12. Out of scope for now

Spaced repetition, vocabulary tracking, audio, multiple users, other news sources, fine-tuning Clef, any public sharing of article text.

## 13. Working agreements

- Verify unknown API details against current docs or real calls (section 3) and say what you verified.
- Ask before spending money (API calls beyond small tests) or changing the architecture.
- Keep commits small and explain what each milestone changed in plain language.
- If an assumption in this plan turns out wrong, flag it and propose a fix; don't paper over it.
