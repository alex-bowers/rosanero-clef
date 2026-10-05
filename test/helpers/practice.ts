import assert from "node:assert/strict";
import { handleApi } from "../../src/api.ts";
import type { ApiDeps, Limits } from "../../src/api.ts";
import { D1Store } from "../../src/db.ts";
import { MockDecisionClient } from "../../src/decision/mock.ts";
import { MockLlmClient } from "../../src/llm/mock.ts";
import { CEFR_LEVELS, summariseRating } from "../../src/rating.ts";
import type { DecisionClient, LlmClient } from "../../src/types.ts";
import { createTestDb } from "./sqlite-d1.ts";

const HEURISTICS = { wordCount: 1, sentenceCount: 1, meanSentenceLength: 1, meanWordLength: 1 };

export const GENEROUS: Limits = { attemptsPerMinute: 1000, explainsPerMinute: 1000, dailyAttempts: 1000, dailyExplains: 1000 };

/** A store with `count` rated, translated B1 chunks. */
export async function seedChunks(count = 1) {
  const db = createTestDb();
  const store = new D1Store(db);
  await store.saveArticle(
    { url: "https://forzapalermo.it/a", title: "Titolo", publishedAt: null, contentHash: "h" },
    Array.from({ length: count }, (_, i) => ({ position: i, text: `frase ${i}`, wordCount: 2, heuristics: HEURISTICS })),
  );
  const ids = (await db.prepare("SELECT id FROM chunks ORDER BY position").all<{ id: number }>()).results.map((r) => r.id);
  for (const [i, id] of ids.entries()) {
    const distribution = CEFR_LEVELS.map((label) => ({ label, probability: label === "B1" ? 0.7 : 0.06 }));
    await store.saveRating(id, distribution, summariseRating(distribution));
    await store.saveTranslation(id, `sentence ${i}`);
  }
  return { db, store, ids };
}

export function makeDeps(
  store: D1Store,
  limits: Limits = GENEROUS,
  overrides: { decision?: DecisionClient; llm?: LlmClient } = {},
): ApiDeps {
  return {
    store,
    decision: overrides.decision ?? new MockDecisionClient({ topIndex: 0, topShare: 0.7 }),
    llm: overrides.llm ?? new MockLlmClient(),
    llmModel: "@cf/test/llm",
    confidenceThreshold: 0.45,
    limits,
  };
}

export const post = (path: string, body: unknown) =>
  new Request(`https://app.test${path}`, { method: "POST", body: JSON.stringify(body) });
export const get = (path: string) => new Request(`https://app.test${path}`);

export async function call(request: Request, deps: ApiDeps) {
  const response = await handleApi(request, deps);
  assert.ok(response, "route was handled");
  return { status: response.status, body: (await response.json()) as any, response };
}

export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const [warn, error] = [console.warn, console.error];
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.warn, console.error] = [warn, error];
  }
}
