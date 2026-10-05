import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseCalls } from "../src/api.ts";
import type { CallRow } from "../src/api.ts";
import type { DecisionClient, LlmClient } from "../src/types.ts";
import { call, get, GENEROUS, makeDeps, post, quietly, seedChunks } from "./helpers/practice.ts";

const rows = async (db: any, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n as number;

test("attempts: the per-minute limit returns 429 with Retry-After, and counts only accepted requests", async () => {
  const { db, store, ids } = await seedChunks();
  const deps = makeDeps(store, { ...GENEROUS, attemptsPerMinute: 2 });

  // These are rejected before they can cost anything, so they do not count.
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "" }), deps)).status, 400);
  assert.equal((await call(post("/api/attempt", { chunkId: 9999, attempt: "x" }), deps)).status, 404);
  assert.equal(await rows(db, "request_log"), 0);

  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "one" }), deps)).status, 200);
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "two" }), deps)).status, 200);

  const third = await call(post("/api/attempt", { chunkId: ids[0], attempt: "three" }), deps);
  assert.equal(third.status, 429);
  assert.equal(third.response.headers.get("retry-after"), "60");
  assert.match(third.body.error, /more than 2 attempts a minute/);
  assert.equal(await rows(db, "request_log"), 2, "the rejected request is not counted");
  assert.equal(await rows(db, "attempts"), 2, "and nothing was scored or stored for it");
});

test("attempts: the limit clears once the requests are more than a minute old", async () => {
  const { db, store, ids } = await seedChunks();
  const deps = makeDeps(store, { ...GENEROUS, attemptsPerMinute: 1 });

  await call(post("/api/attempt", { chunkId: ids[0], attempt: "one" }), deps);
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "two" }), deps)).status, 429);

  await db.prepare("UPDATE request_log SET at = datetime('now', '-2 minutes')").run();
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "three" }), deps)).status, 200);
});

test("attempts: the daily cap returns 429 until the next UTC day", async () => {
  const { db, store, ids } = await seedChunks();
  const deps = makeDeps(store, { ...GENEROUS, dailyAttempts: 2 });

  await call(post("/api/attempt", { chunkId: ids[0], attempt: "one" }), deps);
  await call(post("/api/attempt", { chunkId: ids[0], attempt: "two" }), deps);

  const blocked = await call(post("/api/attempt", { chunkId: ids[0], attempt: "three" }), deps);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /today's limit of 2 attempts/);
  const wait = Number(blocked.response.headers.get("retry-after"));
  assert.ok(wait >= 1 && wait <= 86400, `Retry-After ${wait} is within a day`);

  await db.prepare("UPDATE request_log SET at = datetime('now', '-1 day')").run();
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "four" }), deps)).status, 200);
});

test("attempts: a request that fails at the scorer still counts", async () => {
  const { db, store, ids } = await seedChunks();
  const broken: DecisionClient = { choice: async () => { throw new Error("down"); }, score: async () => { throw new Error("down"); } };
  const deps = makeDeps(store, { ...GENEROUS, attemptsPerMinute: 1 }, { decision: broken });

  assert.equal((await quietly(() => call(post("/api/attempt", { chunkId: ids[0], attempt: "one" }), deps))).status, 502);
  assert.equal(await rows(db, "request_log"), 1, "it may have cost something");
  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "two" }), deps)).status, 429);
});

async function attemptIds(store: any, ids: number[], count: number) {
  const open = makeDeps(store);
  const made = [];
  for (let i = 0; i < count; i++) made.push((await call(post("/api/attempt", { chunkId: ids[0], attempt: `try ${i}` }), open)).body.attemptId);
  return made as number[];
}

test("explain: the limit applies to new explanations, and a stored one is still served", async () => {
  const { db, store, ids } = await seedChunks();
  const [first, second] = await attemptIds(store, ids, 2);
  const deps = makeDeps(store, { ...GENEROUS, explainsPerMinute: 1 });

  assert.equal((await call(post("/api/explain", { attemptId: first }), deps)).status, 200);
  const blocked = await call(post("/api/explain", { attemptId: second }), deps);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /more than 1 explanations a minute/);

  const cached = await call(post("/api/explain", { attemptId: first }), deps);
  assert.equal(cached.status, 200, "an explanation that already exists costs nothing");
  assert.equal(cached.body.cached, true);
  assert.equal(await rows(db, "request_log WHERE route = 'explain'"), 1);
});

test("explain: the daily cap applies, and invalid or unknown requests do not count", async () => {
  const { db, store, ids } = await seedChunks();
  const [first, second] = await attemptIds(store, ids, 2);
  const deps = makeDeps(store, { ...GENEROUS, dailyExplains: 1 });

  assert.equal((await call(post("/api/explain", { attemptId: 0 }), deps)).status, 400);
  assert.equal((await call(post("/api/explain", { attemptId: 9999 }), deps)).status, 404);
  assert.equal(await rows(db, "request_log WHERE route = 'explain'"), 0);

  assert.equal((await call(post("/api/explain", { attemptId: first }), deps)).status, 200);
  const blocked = await call(post("/api/explain", { attemptId: second }), deps);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /today's limit of 1 explanations/);
});

test("the attempt and explain limits are independent", async () => {
  const { store, ids } = await seedChunks();
  const [attemptId] = await attemptIds(store, ids, 1);
  const deps = makeDeps(store, { ...GENEROUS, attemptsPerMinute: 1, dailyAttempts: 1 });

  assert.equal((await call(post("/api/attempt", { chunkId: ids[0], attempt: "again" }), deps)).status, 429);
  const llm: LlmClient = { translate: async () => [], explain: async () => "Fine." };
  assert.equal((await call(post("/api/explain", { attemptId }), makeDeps(store, { ...GENEROUS, attemptsPerMinute: 1, dailyAttempts: 1 }, { llm }))).status, 200);
});

test("pruneOldRows drops stale log rows and keeps recent ones", async () => {
  const { db, store } = await seedChunks();
  await db.prepare("INSERT INTO request_log (route, at) VALUES ('attempt', datetime('now', '-3 days')), ('attempt', datetime('now'))").run();
  await db.prepare("INSERT INTO ai_calls (at, purpose, model, ok, duration_ms) VALUES (datetime('now', '-100 days'), 'score', 'm', 1, 5), (datetime('now', '-10 days'), 'score', 'm', 1, 5)").run();

  await store.pruneOldRows();
  assert.equal(await rows(db, "request_log"), 1);
  assert.equal(await rows(db, "ai_calls"), 1, "10 days old is kept, 100 days old is not");
});

// ---- Usage ----

const row = (over: Partial<CallRow>): CallRow => ({ purpose: "score", model: "clef", ok: true, durationMs: 100, inputTokens: 10, outputTokens: 0, ...over });

test("summariseCalls groups by purpose and model, with nearest-rank percentiles over successes", () => {
  const summary = summariseCalls([
    ...[10, 20, 30, 40, 50].map((durationMs) => row({ durationMs })),
    row({ ok: false, durationMs: 9999, inputTokens: null }),
    row({ purpose: "explain", model: "mistral", durationMs: 700, inputTokens: 100, outputTokens: 60 }),
  ]);

  assert.equal(summary.length, 2);
  const [explain, score] = summary;
  assert.equal(explain.purpose, "explain");
  assert.deepEqual({ calls: explain.calls, medianMs: explain.medianMs, outputTokens: explain.outputTokens }, { calls: 1, medianMs: 700, outputTokens: 60 });
  assert.deepEqual(
    { calls: score.calls, failures: score.failures, medianMs: score.medianMs, p95Ms: score.p95Ms, inputTokens: score.inputTokens },
    { calls: 6, failures: 1, medianMs: 30, p95Ms: 50, inputTokens: 50 },
    "the 9999 ms failure is excluded from latency, and a null token count counts as zero",
  );
});

test("summariseCalls handles a group with no successful calls", () => {
  const [only] = summariseCalls([row({ ok: false })]);
  assert.deepEqual({ medianMs: only.medianMs, p95Ms: only.p95Ms, failures: only.failures }, { medianMs: null, p95Ms: null, failures: 1 });
});

test("GET /api/usage reports today's counts against the limits, and the recorded calls", async () => {
  const { db, store, ids } = await seedChunks();
  const deps = makeDeps(store, { ...GENEROUS, dailyAttempts: 5, dailyExplains: 3 });
  await call(post("/api/attempt", { chunkId: ids[0], attempt: "one" }), deps);
  await store.recordCall("score", { model: "@cf/cloudflare/clef", ok: true, durationMs: 250, inputTokens: 228, outputTokens: 0 });
  await db.prepare("INSERT INTO ai_calls (at, purpose, model, ok, duration_ms) VALUES (datetime('now', '-20 days'), 'score', 'old', 1, 1)").run();

  const { status, body } = await call(get("/api/usage?days=7"), deps);
  assert.equal(status, 200);
  assert.deepEqual(body.today, { attempts: { used: 1, limit: 5 }, explanations: { used: 0, limit: 3 } });
  assert.equal(body.days, 7);
  assert.equal(body.calls.length, 1, "the 20-day-old call is outside the window");
  assert.deepEqual({ purpose: body.calls[0].purpose, model: body.calls[0].model, medianMs: body.calls[0].medianMs, inputTokens: body.calls[0].inputTokens }, { purpose: "score", model: "@cf/cloudflare/clef", medianMs: 250, inputTokens: 228 });
});

test("GET /api/usage validates days and only accepts GET", async () => {
  const { store } = await seedChunks();
  const deps = makeDeps(store);
  for (const days of ["0", "91", "x", "1.5"]) assert.equal((await call(get(`/api/usage?days=${days}`), deps)).status, 400, days);
  assert.equal((await call(post("/api/usage", {}), deps)).status, 405);
});

test("GET /api/usage says when the totals cover only the newest 5,000 calls", async () => {
  const { db, store } = await seedChunks();
  const deps = makeDeps(store, GENEROUS);
  await db.batch(
    Array.from({ length: 5001 }, () =>
      db.prepare("INSERT INTO ai_calls (purpose, model, ok, duration_ms) VALUES ('score', 'm', 1, 5)"),
    ),
  );

  const { body } = await call(get("/api/usage?days=7"), deps);
  assert.equal(body.truncated, true);
  assert.equal(body.calls[0].calls, 5000);
});
