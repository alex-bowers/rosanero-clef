import { test } from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/db.ts";
import { runRating } from "../src/rate.ts";
import { MockDecisionClient } from "../src/decision/mock.ts";
import type { DecisionClient } from "../src/types.ts";
import { createTestDb } from "./helpers/sqlite-d1.ts";

const HEURISTICS = { wordCount: 1, sentenceCount: 1, meanSentenceLength: 1, meanWordLength: 1 };

async function seed(count: number) {
  const db = createTestDb();
  const store = new D1Store(db);
  const chunks = Array.from({ length: count }, (_, i) => ({
    position: i, text: `frase ${i}`, wordCount: 2, heuristics: HEURISTICS,
  }));
  await store.saveArticle({ url: "https://forzapalermo.it/a", title: "A", publishedAt: null, contentHash: "h" }, chunks);
  return { db, store };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test("rates every unrated chunk and stores the distribution and summary", async () => {
  const { db, store } = await seed(3);
  const decision = new MockDecisionClient({ topIndex: 2, topShare: 0.6 }); // B1

  const summary = await runRating({ store, decision });
  assert.deepEqual(summary, { rated: 3, failed: 0, stoppedEarly: false });

  const row = await db
    .prepare("SELECT cefr_top, cefr_confidence, cefr_expected, cefr_probs_json FROM chunks WHERE position = 0")
    .first<{ cefr_top: string; cefr_confidence: number; cefr_expected: number; cefr_probs_json: string }>();
  assert.equal(row?.cefr_top, "B1");
  assert.ok(Math.abs((row?.cefr_confidence ?? 0) - 0.6) < 1e-9);
  assert.equal(JSON.parse(row!.cefr_probs_json).length, 6);

  assert.equal((await store.unratedChunks(10)).length, 0);
  assert.deepEqual(await runRating({ store, decision }), { rated: 0, failed: 0, stoppedEarly: false });
});

test("passes the Italian text and CEFR options to the decision client", async () => {
  const { store } = await seed(1);
  const seen: any[] = [];
  const decision: DecisionClient = {
    choice: async (opts) => {
      seen.push(opts);
      return opts.options.map((label, i) => ({ label, probability: i === 0 ? 1 : 0 }));
    },
    score: async () => [],
  };

  await runRating({ store, decision });
  assert.equal(seen[0].state, "frase 0");
  assert.deepEqual(seen[0].options, ["A1", "A2", "B1", "B2", "C1", "C2"]);
  assert.ok(seen[0].descriptions.B1);
});

test("a single failure is counted and later chunks are still rated", async () => {
  const { store } = await seed(3);
  const inner = new MockDecisionClient();
  let calls = 0;
  const decision: DecisionClient = {
    choice: async (opts) => {
      if (++calls === 1) throw new Error("boom");
      return inner.choice(opts);
    },
    score: (opts) => inner.score(opts),
  };

  const summary = await quietly(() => runRating({ store, decision }));
  assert.deepEqual(summary, { rated: 2, failed: 1, stoppedEarly: false });
  assert.equal((await store.unratedChunks(10)).length, 1, "the failed chunk is retried next run");
});

test("stops after three consecutive failures", async () => {
  const { store } = await seed(6);
  let calls = 0;
  const decision: DecisionClient = {
    choice: async () => {
      calls++;
      throw new Error("unauthorised");
    },
    score: async () => [],
  };

  const summary = await quietly(() => runRating({ store, decision }));
  assert.deepEqual(summary, { rated: 0, failed: 3, stoppedEarly: true });
  assert.equal(calls, 3);
});
