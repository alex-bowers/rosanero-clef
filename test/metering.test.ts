import { test } from "node:test";
import assert from "node:assert/strict";
import { ClefClient } from "../src/decision/clef.ts";
import { limitsFrom } from "../src/app.ts";
import worker from "../src/app.ts";
import { runSteps } from "../src/jobs.ts";
import { WorkersAiLlmClient } from "../src/llm/workersai.ts";
import { metered, readUsage } from "../src/metering.ts";
import type { CallRecord } from "../src/metering.ts";
import type { Env } from "../src/types.ts";
import { quietly } from "./helpers/practice.ts";
import { CHOICE_RESPONSE } from "./fixtures/clef-responses.ts";

const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

test("readUsage reads Clef and OpenAI-style token counts, and tolerates anything else", () => {
  assert.deepEqual(readUsage({ usage: { input_tokens: 228, output_tokens: 0 } }), { inputTokens: 228, outputTokens: 0 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 93, completion_tokens: 40 } }), { inputTokens: 93, outputTokens: 40 });
  for (const odd of [null, undefined, {}, { usage: null }, { usage: { input_tokens: "12" } }]) {
    assert.deepEqual(readUsage(odd), { inputTokens: null, outputTokens: null });
  }
});

test("metered reports a success with timing and tokens", async () => {
  const seen: CallRecord[] = [];
  const result = await metered("m", (call) => void seen.push(call), async () => ({ usage: { input_tokens: 5, output_tokens: 1 } }));
  assert.deepEqual(result, { usage: { input_tokens: 5, output_tokens: 1 } });
  assert.equal(seen.length, 1);
  assert.deepEqual({ model: seen[0].model, ok: seen[0].ok, inputTokens: seen[0].inputTokens, outputTokens: seen[0].outputTokens }, { model: "m", ok: true, inputTokens: 5, outputTokens: 1 });
  assert.ok(seen[0].durationMs >= 0);
});

test("metered reports a failure and rethrows the original error", async () => {
  const seen: CallRecord[] = [];
  const failure = new Error("boom");
  await assert.rejects(metered("m", (call) => void seen.push(call), async () => { throw failure; }), (error) => error === failure);
  assert.deepEqual({ ok: seen[0].ok, inputTokens: seen[0].inputTokens }, { ok: false, inputTokens: null });
});

test("a listener that throws never breaks the call", async () => {
  const result = await quietly(() => metered("m", () => { throw new Error("log failed"); }, async () => "fine"));
  assert.equal(result, "fine");
});

test("ClefClient reports every call, including a failed attempt that is retried", async () => {
  const seen: CallRecord[] = [];
  let n = 0;
  const ai = { run: async () => { if (++n === 1) throw new Error("upstream unavailable"); return CHOICE_RESPONSE; } };
  const client = new ClefClient(ai, { model: "@cf/cloudflare/clef", retries: 1, onCall: (call) => void seen.push(call) });

  await client.choice({ state: "x", instructions: "y", options: CEFR });
  assert.deepEqual(seen.map((c) => c.ok), [false, true]);
  assert.equal(seen[1].model, "@cf/cloudflare/clef");
  assert.equal(seen[1].inputTokens, 228);
  assert.equal(seen[1].outputTokens, 0);
});

test("WorkersAiLlmClient reports its calls with OpenAI-style token counts", async () => {
  const seen: CallRecord[] = [];
  const ai = { run: async () => ({ response: "Hello.", usage: { prompt_tokens: 93, completion_tokens: 12 } }) };
  const client = new WorkersAiLlmClient(ai, { model: "@cf/test/llm", onCall: (call) => void seen.push(call) });

  await client.translate(["Ciao."]);
  assert.deepEqual({ ok: seen[0].ok, inputTokens: seen[0].inputTokens, outputTokens: seen[0].outputTokens }, { ok: true, inputTokens: 93, outputTokens: 12 });
});

test("limitsFrom uses the configured values, and falls back for missing or invalid ones", () => {
  assert.deepEqual(limitsFrom({}), { attemptsPerMinute: 10, explainsPerMinute: 5, dailyAttempts: 200, dailyExplains: 50 });
  assert.deepEqual(
    limitsFrom({ ATTEMPTS_PER_MINUTE: "3", EXPLAINS_PER_MINUTE: "0", DAILY_ATTEMPT_CAP: "40", DAILY_EXPLAIN_CAP: "7" }),
    { attemptsPerMinute: 3, explainsPerMinute: 0, dailyAttempts: 40, dailyExplains: 7 },
  );
  assert.deepEqual(
    limitsFrom({ ATTEMPTS_PER_MINUTE: "abc", EXPLAINS_PER_MINUTE: "-1", DAILY_ATTEMPT_CAP: "", DAILY_EXPLAIN_CAP: "2.5" }),
    { attemptsPerMinute: 10, explainsPerMinute: 5, dailyAttempts: 200, dailyExplains: 50 },
  );
});

test("runSteps keeps going after a failed step and reports each result", async () => {
  const ran: string[] = [];
  const results = await quietly(() =>
    runSteps([
      ["one", async () => (ran.push("one"), { done: true })],
      ["two", async () => { throw new Error("broke"); }],
      ["three", async () => (ran.push("three"), 3)],
    ]),
  );
  assert.deepEqual(ran, ["one", "three"]);
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [["one", true], ["two", false], ["three", true]]);
  assert.match(results[1].error ?? "", /broke/);
});

// ---- The Worker's error handling ----

function env(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({}) },
    DB: { prepare: () => { throw new Error("D1 is down"); }, batch: async () => [] },
    ASSETS: { fetch: async () => new Response("<html>asset</html>") },
    DECISION_MODEL: "d", SCORING_MODEL: "s", LLM_MODEL: "l", CONFIDENCE_THRESHOLD: "0.45",
    ...overrides,
  } as Env;
}

test("an unexpected failure becomes a clean JSON 500 that hides the detail", async () => {
  const response = await quietly(() => worker.fetch(new Request("https://app.test/api/settings"), env()));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.error, /Something went wrong/);
  assert.ok(!JSON.stringify(body).includes("D1 is down"));
});

test("health, assets and unknown API paths still work when the database is down", async () => {
  assert.equal((await worker.fetch(new Request("https://app.test/api/health"), env())).status, 200);
  assert.equal(await (await worker.fetch(new Request("https://app.test/"), env())).text(), "<html>asset</html>");
});
