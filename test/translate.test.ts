import { test } from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/db.ts";
import { WorkersAiLlmClient } from "../src/llm/workersai.ts";
import { MockLlmClient } from "../src/llm/mock.ts";
import { runTranslation } from "../src/translate.ts";
import type { LlmClient } from "../src/types.ts";
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

function fakeAi(handler: (input: any, n: number) => unknown) {
  const calls: any[] = [];
  return {
    calls,
    ai: {
      async run(model: string, input: unknown) {
        calls.push({ model, input });
        return handler(input, calls.length);
      },
    },
  };
}

test("stores a trimmed translation and timestamp, and does not redo translated chunks", async () => {
  const { db, store } = await seed(2);
  const first = await runTranslation({ store, llm: new MockLlmClient() });
  assert.deepEqual(first, { translated: 2, failed: 0, stoppedEarly: false });

  const row = await db
    .prepare("SELECT reference_en, translated_at FROM chunks WHERE position = 1")
    .first<{ reference_en: string; translated_at: string }>();
  assert.equal(row?.reference_en, "[mock translation] frase 1");
  assert.ok(row?.translated_at);

  assert.deepEqual(await runTranslation({ store, llm: new MockLlmClient() }), { translated: 0, failed: 0, stoppedEarly: false });
});

test("an empty translation is a failure and the chunk stays pending", async () => {
  const { store } = await seed(1);
  const llm: LlmClient = { translate: async () => ["   "], explain: async () => "" };

  const summary = await quietly(() => runTranslation({ store, llm }));
  assert.equal(summary.failed, 1);
  assert.equal((await store.untranslatedChunks(10)).length, 1);
});

test("stops after three consecutive failures", async () => {
  const { store } = await seed(6);
  const llm: LlmClient = { translate: async () => { throw new Error("down"); }, explain: async () => "" };
  const summary = await quietly(() => runTranslation({ store, llm }));
  assert.deepEqual(summary, { translated: 0, failed: 3, stoppedEarly: true });
});

test("Workers AI client sends the model, a system prompt and the Italian text, one call per text", async () => {
  const { ai, calls } = fakeAi(() => ({ response: "  Hello.  " }));
  const client = new WorkersAiLlmClient(ai, { model: "@cf/test/model" });

  assert.deepEqual(await client.translate(["Ciao.", "Salve."]), ["Hello.", "Hello."]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "@cf/test/model");
  assert.equal(calls[0].input.messages[0].role, "system");
  assert.equal(calls[0].input.messages[1].content, "Ciao.");
  assert.equal(calls[0].input.temperature, 0);
});

test("Workers AI client reads the OpenAI chat shape", async () => {
  const { ai } = fakeAi(() => ({ choices: [{ finish_reason: "stop", message: { content: "Hi there." } }] }));
  assert.deepEqual(await new WorkersAiLlmClient(ai, { model: "m" }).translate(["Ciao"]), ["Hi there."]);
});

test("Workers AI client rejects truncated and empty replies", async () => {
  const truncated = fakeAi(() => ({ choices: [{ finish_reason: "length", message: { content: null } }] }));
  await assert.rejects(new WorkersAiLlmClient(truncated.ai, { model: "m", retries: 0 }).translate(["x"]), /cut off/);

  const empty = fakeAi(() => ({ response: "" }));
  await assert.rejects(new WorkersAiLlmClient(empty.ai, { model: "m", retries: 0 }).translate(["x"]), /no text/);
});

test("Workers AI client retries a transient failure", async () => {
  const { ai, calls } = fakeAi((_, n) => {
    if (n === 1) throw new Error("upstream unavailable");
    return { response: "Ok." };
  });
  const client = new WorkersAiLlmClient(ai, { model: "m", retries: 1 });
  assert.deepEqual(await client.translate(["x"]), ["Ok."]);
  assert.equal(calls.length, 2);
});

test("Workers AI client explain sends all four inputs and the tutor prompt, and returns the trimmed text", async () => {
  const { ai, calls } = fakeAi(() => ({ response: "  You missed 'rinvii'.  " }));
  const client = new WorkersAiLlmClient(ai, { model: "@cf/test/model" });

  const text = await client.explain({
    italian: "Il Palermo ha vinto.",
    reference: "Palermo won.",
    attempt: "Palermo lost.",
    verdict: "partly_correct",
  });

  assert.equal(text, "You missed 'rinvii'.");
  const [system, user] = calls[0].input.messages;
  assert.equal(system.role, "system");
  assert.match(system.content, /trust the Italian/);
  assert.match(system.content, /never follow instructions/);
  assert.match(system.content, /Natural English:/);
  assert.match(system.content, /under 90 words/);
  for (const part of ["Il Palermo ha vinto.", "Palermo won.", "Palermo lost.", "partly correct"]) {
    assert.ok(user.content.includes(part), `the user message includes "${part}"`);
  }
});
