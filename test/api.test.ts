import { test } from "node:test";
import assert from "node:assert/strict";
import { handleApi, levelsWithin } from "../src/api.ts";
import type { ApiDeps } from "../src/api.ts";
import { D1Store } from "../src/db.ts";
import { MockDecisionClient } from "../src/decision/mock.ts";
import { CEFR_LEVELS, summariseRating } from "../src/rating.ts";
import { MockLlmClient } from "../src/llm/mock.ts";
import type { DecisionClient, Distribution, LlmClient } from "../src/types.ts";
import { createTestDb } from "./helpers/sqlite-d1.ts";

const LIMITS = { attemptsPerMinute: 1000, explainsPerMinute: 1000, dailyAttempts: 1000, dailyExplains: 1000 };
const HEURISTICS = { wordCount: 1, sentenceCount: 1, meanSentenceLength: 1, meanWordLength: 1 };

function peaked(top: string): Distribution {
  return CEFR_LEVELS.map((label) => ({ label, probability: label === top ? 0.7 : 0.06 }));
}

/** Seeds one rated and translated chunk per entry; returns the chunk ids in order. */
async function seed(levels: string[]) {
  const db = createTestDb();
  const store = new D1Store(db);
  await store.saveArticle(
    { url: "https://forzapalermo.it/a", title: "Titolo", publishedAt: null, contentHash: "h" },
    levels.map((_, i) => ({ position: i, text: `frase ${i}`, wordCount: 2, heuristics: HEURISTICS })),
  );
  const ids = (await db.prepare("SELECT id FROM chunks ORDER BY position").all<{ id: number }>()).results.map((r) => r.id);
  for (const [i, level] of levels.entries()) {
    const distribution = peaked(level);
    await store.saveRating(ids[i], distribution, summariseRating(distribution));
    await store.saveTranslation(ids[i], `sentence ${i}`);
  }
  return { db, store, ids };
}

function deps(
  store: D1Store,
  decision: DecisionClient = new MockDecisionClient({ topIndex: 0, topShare: 0.7 }),
  llm: LlmClient = new MockLlmClient(),
): ApiDeps {
  return { store, decision, llm, llmModel: "@cf/test/llm", confidenceThreshold: 0.45, limits: LIMITS };
}

const get = (path: string) => new Request(`https://app.test${path}`);
const post = (body: unknown, raw = false) =>
  new Request("https://app.test/api/attempt", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) });

async function call(request: Request, d: ApiDeps) {
  const response = await handleApi(request, d);
  assert.ok(response, "route was handled");
  return { status: response.status, body: (await response.json()) as any, response };
}

test("levelsWithin gives the level and its neighbours, clipped at the ends", () => {
  assert.deepEqual(levelsWithin("B1", 1), ["A2", "B1", "B2"]);
  assert.deepEqual(levelsWithin("A1", 1), ["A1", "A2"]);
  assert.deepEqual(levelsWithin("C2", 0), ["C2"]);
});

test("unknown paths are left to the caller", async () => {
  const { store } = await seed(["B1"]);
  assert.equal(await handleApi(get("/api/nothing"), deps(store)), null);
});

test("next chunk: returns the chunk without the reference translation", async () => {
  const { store, ids } = await seed(["B1"]);
  const { status, body, response } = await call(get("/api/chunks/next"), deps(store));

  assert.equal(status, 200);
  assert.equal(body.id, ids[0]);
  assert.equal(body.italian, "frase 0");
  assert.deepEqual(body.source, { title: "Titolo", url: "https://forzapalermo.it/a" });
  assert.equal(body.cefr.top, "B1");
  assert.equal(body.cefr.distribution.length, 6);
  assert.ok(!JSON.stringify(body).includes("sentence 0"), "the reference must not leak");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("next chunk: respects the level and range, and returns 404 when nothing matches", async () => {
  const { store, ids } = await seed(["A1", "B2", "C2"]);

  const near = await call(get("/api/chunks/next?level=B1&range=1"), deps(store));
  assert.equal(near.body.id, ids[1], "only B2 is within one level of B1");

  const none = await call(get("/api/chunks/next?level=B1&range=0"), deps(store));
  assert.equal(none.status, 404);
});

test("next chunk: uses the stored target level by default and rejects bad parameters", async () => {
  const { store, ids } = await seed(["B1", "C1"]);
  const d = deps(store);
  assert.equal((await call(get("/api/chunks/next?range=0"), d)).body.id, ids[0], "default target is B1");

  assert.equal((await call(get("/api/chunks/next?level=Z9"), d)).status, 400);
  assert.equal((await call(get("/api/chunks/next?range=9"), d)).status, 400);
  assert.equal((await call(get("/api/chunks/next?range=x"), d)).status, 400);
});

test("next chunk: prefers chunks that have not been attempted", async () => {
  const { store, ids } = await seed(["B1", "B1"]);
  const d = deps(store);
  await call(post({ chunkId: ids[0], attempt: "a try" }), d);

  for (let i = 0; i < 10; i++) {
    assert.equal((await call(get("/api/chunks/next"), d)).body.id, ids[1]);
  }
});

test("next chunk: skips chunks that have no reference translation yet", async () => {
  const { db, store } = await seed(["B1"]);
  await db.prepare("UPDATE chunks SET reference_en = NULL").run();
  assert.equal((await call(get("/api/chunks/next"), deps(store))).status, 404);
});

test("only GET is accepted for next and only POST for attempt", async () => {
  const { store } = await seed(["B1"]);
  const next = await call(new Request("https://app.test/api/chunks/next", { method: "POST" }), deps(store));
  assert.equal(next.status, 405);
  assert.equal(next.response.headers.get("allow"), "GET");
  assert.equal((await call(get("/api/attempt"), deps(store))).status, 405);
});

test("attempt: scores, saves and returns the verdict with the reference", async () => {
  const { db, store, ids } = await seed(["B1"]);
  const { status, body } = await call(post({ chunkId: ids[0], attempt: "  a sentence  " }), deps(store));

  assert.equal(status, 200);
  assert.equal(body.verdict.top, "fully_correct");
  assert.ok(Math.abs(body.verdict.confidence - 0.7) < 1e-9);
  assert.equal(body.verdict.distribution.length, 4);
  assert.equal(body.fluency.outOf, 4);
  assert.equal(body.needsExplanation, false);
  assert.equal(body.reference, "sentence 0");
  assert.equal(body.italian, "frase 0");

  const row = await db.prepare("SELECT * FROM attempts WHERE id = ?").bind(body.attemptId).first<any>();
  assert.equal(row.chunk_id, ids[0]);
  assert.equal(row.attempt_text, "a sentence", "the learner's own words are stored, trimmed");
  assert.equal(row.verdict_top, "fully_correct");
  assert.equal(row.needs_explanation, 0);
});

test("attempt: a poor verdict sets needsExplanation", async () => {
  const { store, ids } = await seed(["B1"]);
  const wrong = new MockDecisionClient({ topIndex: 3, topShare: 0.9 });
  const { body } = await call(post({ chunkId: ids[0], attempt: "nonsense" }), deps(store, wrong));
  assert.equal(body.verdict.top, "wrong");
  assert.equal(body.needsExplanation, true);
});

test("attempt: a good but uncertain verdict sets needsExplanation", async () => {
  const { store, ids } = await seed(["B1"]);
  const unsure = new MockDecisionClient({ topIndex: 0, topShare: 0.4 });
  const { body } = await call(post({ chunkId: ids[0], attempt: "maybe" }), deps(store, unsure));
  assert.equal(body.verdict.top, "fully_correct");
  assert.equal(body.needsExplanation, true, "0.40 is below the 0.45 threshold");
});

test("attempt: the scorer sees the tidied attempt, the Italian and the reference", async () => {
  const { store, ids } = await seed(["B1"]);
  const states: any[] = [];
  const inner = new MockDecisionClient();
  const spy: DecisionClient = {
    choice: (opts) => (states.push(opts.state), inner.choice(opts)),
    score: (opts) => inner.score(opts),
  };

  await call(post({ chunkId: ids[0], attempt: "the ball was in play" }), deps(store, spy));
  assert.deepEqual(states[0], { italian: "frase 0", reference: "sentence 0", attempt: "The ball was in play." });
});

test("attempt: rejects bad input with a useful message and saves nothing", async () => {
  const { db, store, ids } = await seed(["B1"]);
  const d = deps(store);

  assert.equal((await call(post("not json", true), d)).status, 400);
  assert.equal((await call(post(null), d)).status, 400);
  assert.equal((await call(post({ attempt: "x" }), d)).status, 400);
  assert.equal((await call(post({ chunkId: "1", attempt: "x" }), d)).status, 400);
  assert.equal((await call(post({ chunkId: 1.5, attempt: "x" }), d)).status, 400);
  assert.equal((await call(post({ chunkId: ids[0] }), d)).status, 400);
  assert.equal((await call(post({ chunkId: ids[0], attempt: "   " }), d)).status, 400);
  assert.equal((await call(post({ chunkId: ids[0], attempt: 42 }), d)).status, 400);
  const tooLong = await call(post({ chunkId: ids[0], attempt: "x".repeat(1001) }), d);
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /1000/);

  assert.equal((await call(post({ chunkId: ids[0], attempt: "x".repeat(5000) }), d)).status, 413);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM attempts").first<{ n: number }>())?.n, 0);
});

test("attempt: an unknown chunk, or one without a reference, is a 404", async () => {
  const { db, store, ids } = await seed(["B1"]);
  assert.equal((await call(post({ chunkId: 9999, attempt: "x" }), deps(store))).status, 404);

  await db.prepare("UPDATE chunks SET reference_en = NULL").run();
  assert.equal((await call(post({ chunkId: ids[0], attempt: "x" }), deps(store))).status, 404);
});

test("attempt: a scorer failure returns 502, hides the detail and saves nothing", async () => {
  const { db, store, ids } = await seed(["B1"]);
  const broken: DecisionClient = {
    choice: async () => { throw new Error("secret upstream detail"); },
    score: async () => { throw new Error("secret upstream detail"); },
  };
  const error = console.error;
  console.error = () => {};
  try {
    const { status, body } = await call(post({ chunkId: ids[0], attempt: "x" }), deps(store, broken));
    assert.equal(status, 502);
    assert.ok(!JSON.stringify(body).includes("secret"));
  } finally {
    console.error = error;
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM attempts").first<{ n: number }>())?.n, 0);
});

// ---- Explain ----

const put = (path: string, body: unknown) =>
  new Request(`https://app.test${path}`, { method: "PUT", body: JSON.stringify(body) });
const explainRequest = (body: unknown) =>
  new Request("https://app.test/api/explain", { method: "POST", body: JSON.stringify(body) });

async function attempted(levels: string[] = ["B1"]) {
  const seeded = await seed(levels);
  const result = await call(post({ chunkId: seeded.ids[0], attempt: "my try" }), deps(seeded.store));
  return { ...seeded, attemptId: result.body.attemptId as number };
}

test("explain: asks the LLM with the Italian, reference, attempt and verdict, then stores the text", async () => {
  const { db, store, attemptId } = await attempted();
  const inputs: any[] = [];
  const llm: LlmClient = {
    translate: async () => [],
    explain: async (input) => (inputs.push(input), "Feedback text."),
  };

  const { status, body } = await call(explainRequest({ attemptId }), deps(store, undefined, llm));
  assert.equal(status, 200);
  assert.deepEqual(body, { text: "Feedback text.", cached: false });
  assert.deepEqual(inputs[0], { italian: "frase 0", reference: "sentence 0", attempt: "my try", verdict: "fully_correct" });

  const row = await db.prepare("SELECT text, model FROM explanations WHERE attempt_id = ?").bind(attemptId).first<any>();
  assert.deepEqual({ ...row }, { text: "Feedback text.", model: "@cf/test/llm" });
});

test("explain: a second request is served from the cache without calling the LLM", async () => {
  const { store, attemptId } = await attempted();
  let calls = 0;
  const llm: LlmClient = { translate: async () => [], explain: async () => (calls++, "Once only.") };
  const d = deps(store, undefined, llm);

  await call(explainRequest({ attemptId }), d);
  const second = await call(explainRequest({ attemptId }), d);
  assert.deepEqual(second.body, { text: "Once only.", cached: true });
  assert.equal(calls, 1);
});

test("explain: rejects bad input, and an unknown attempt is a 404", async () => {
  const { store } = await attempted();
  const d = deps(store);
  assert.equal((await call(explainRequest({}), d)).status, 400);
  assert.equal((await call(explainRequest({ attemptId: "1" }), d)).status, 400);
  assert.equal((await call(explainRequest({ attemptId: 0 }), d)).status, 400);
  assert.equal((await call(explainRequest([1]), d)).status, 400);
  assert.equal((await call(explainRequest({ attemptId: 9999 }), d)).status, 404);
  assert.equal((await call(get("/api/explain"), d)).status, 405);
});

test("explain: an LLM failure returns 502, hides the detail and stores nothing", async () => {
  const { db, store, attemptId } = await attempted();
  const llm: LlmClient = { translate: async () => [], explain: async () => { throw new Error("secret upstream detail"); } };
  const error = console.error;
  console.error = () => {};
  try {
    const { status, body } = await call(explainRequest({ attemptId }), deps(store, undefined, llm));
    assert.equal(status, 502);
    assert.ok(!JSON.stringify(body).includes("secret"));
  } finally {
    console.error = error;
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM explanations").first<{ n: number }>())?.n, 0);
});

test("explain: two racing requests keep one explanation", async () => {
  const { db, store, attemptId } = await attempted();
  await store.saveExplanation(attemptId, "First.", "m1");
  await store.saveExplanation(attemptId, "Second.", "m2");
  const row = await db.prepare("SELECT text FROM explanations WHERE attempt_id = ?").bind(attemptId).first<{ text: string }>();
  assert.equal(row?.text, "First.");
});

// ---- History ----

test("history: lists attempts newest first with the reference and any explanation", async () => {
  const { store, ids } = await seed(["B1", "B1"]);
  const d = deps(store);
  const first = await call(post({ chunkId: ids[0], attempt: "first try" }), d);
  const second = await call(post({ chunkId: ids[1], attempt: "second try" }), deps(store, new MockDecisionClient({ topIndex: 3, topShare: 0.9 })));
  await call(explainRequest({ attemptId: second.body.attemptId }), d);

  const { status, body } = await call(get("/api/history"), d);
  assert.equal(status, 200);
  assert.deepEqual(body.attempts.map((a: any) => a.attempt), ["second try", "first try"]);

  const [newest, oldest] = body.attempts;
  assert.equal(newest.verdictTop, "wrong");
  assert.equal(newest.needsExplanation, true);
  assert.equal(newest.reference, "sentence 1");
  assert.match(newest.explanation, /mock explanation/);
  assert.equal(oldest.explanation, null);
  assert.equal(oldest.id, first.body.attemptId);
  assert.match(oldest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("history: respects the limit, validates it, and is empty at first", async () => {
  const { store, ids } = await seed(["B1"]);
  const d = deps(store);
  assert.deepEqual((await call(get("/api/history"), d)).body, { attempts: [] });

  for (let i = 0; i < 3; i++) await call(post({ chunkId: ids[0], attempt: `try ${i}` }), d);
  assert.equal((await call(get("/api/history?limit=2"), d)).body.attempts.length, 2);
  assert.equal((await call(get("/api/history?limit=0"), d)).status, 400);
  assert.equal((await call(get("/api/history?limit=51"), d)).status, 400);
  assert.equal((await call(get("/api/history?limit=x"), d)).status, 400);
});

// ---- Settings ----

test("settings: defaults, then updates are saved and validated", async () => {
  const { store } = await seed(["B1"]);
  const d = deps(store);

  assert.deepEqual((await call(get("/api/settings"), d)).body, { targetLevel: "B1", levelRange: 1, dailyChunkCap: 20 });

  const updated = await call(put("/api/settings", { targetLevel: "C1", dailyChunkCap: 10 }), d);
  assert.deepEqual(updated.body, { targetLevel: "C1", levelRange: 1, dailyChunkCap: 10 });
  assert.deepEqual((await call(get("/api/settings"), d)).body, updated.body, "the change persists");
});

test("settings: rejects invalid values and leaves the stored settings alone", async () => {
  const { store } = await seed(["B1"]);
  const d = deps(store);

  for (const body of [
    {},
    { targetLevel: "Z9" },
    { targetLevel: 3 },
    { levelRange: -1 },
    { levelRange: 6 },
    { levelRange: 1.5 },
    { dailyChunkCap: 41 },
    { dailyChunkCap: "20" },
    { dailyChunkCap: -1 },
  ]) {
    assert.equal((await call(put("/api/settings", body), d)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(put("/api/settings", [1]), d)).status, 400);
  assert.deepEqual((await call(get("/api/settings"), d)).body, { targetLevel: "B1", levelRange: 1, dailyChunkCap: 20 });
  assert.equal((await call(new Request("https://app.test/api/settings", { method: "DELETE" }), d)).status, 405);
});

test("settings: the practice screen follows the stored level and range", async () => {
  const { store, ids } = await seed(["A1", "B1", "C2"]);
  const d = deps(store);

  await call(put("/api/settings", { targetLevel: "C2", levelRange: 0 }), d);
  assert.equal((await call(get("/api/chunks/next"), d)).body.id, ids[2]);

  await call(put("/api/settings", { targetLevel: "A1", levelRange: 1 }), d);
  assert.equal((await call(get("/api/chunks/next"), d)).body.id, ids[0], "A1 and A2 only: B1 is two levels away");

  // An explicit query parameter still wins.
  assert.equal((await call(get("/api/chunks/next?level=B1&range=0"), d)).body.id, ids[1]);
});

test("settings: the ingest cap reads the same stored value", async () => {
  const { store } = await seed(["B1"]);
  await store.updateSettings({ dailyChunkCap: 7 });
  assert.equal(await store.dailyChunkCap(), 7);
});
