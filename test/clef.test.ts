import { test } from "node:test";
import assert from "node:assert/strict";
import { ClefClient } from "../src/decision/clef.ts";
import { CHOICE_RESPONSE, INVALID_REQUEST_ERROR, SCORE_RESPONSE } from "./fixtures/clef-responses.ts";

type Call = { model: string; input: any };

function fakeAi(handler: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const ai = {
    async run(model: string, input: unknown) {
      calls.push({ model, input });
      return handler({ model, input }, calls.length);
    },
  };
  return { ai, calls };
}

const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

test("choice sends a criteria map and returns probabilities in option order", async () => {
  const { ai, calls } = fakeAi(() => CHOICE_RESPONSE);
  const client = new ClefClient(ai, { model: "@cf/cloudflare/clef-flash" });

  const result = await client.choice({
    state: "testo",
    instructions: "Rate it",
    options: CEFR,
    descriptions: { A1: "Very basic" },
  });

  assert.deepEqual(result.map((r) => r.label), CEFR);
  assert.equal(result[2].probability, 0.4504);
  assert.equal(calls[0].model, "@cf/cloudflare/clef-flash");
  assert.deepEqual(calls[0].input.questions.q.criteria.A1, "Very basic");
  assert.equal(calls[0].input.questions.q.criteria.B1, "B1", "falls back to the label");
  assert.equal(calls[0].input.questions.q.type, "choice");
});

test("score sends an array of level descriptions and returns 0-indexed labels", async () => {
  const { ai, calls } = fakeAi(() => SCORE_RESPONSE);
  const client = new ClefClient(ai, { model: "@cf/cloudflare/clef-flash" });

  const result = await client.score({ state: "x", instructions: "Rate", levels: 5 });

  assert.deepEqual(result.map((r) => r.label), ["0", "1", "2", "3", "4"]);
  assert.equal(calls[0].input.questions.q.criteria.length, 5);
  assert.equal(calls[0].input.questions.q.type, "score");
});

test("retries a transient failure, then succeeds", async () => {
  const { ai, calls } = fakeAi((_, n) => {
    if (n === 1) throw new Error("upstream unavailable");
    return CHOICE_RESPONSE;
  });
  const client = new ClefClient(ai, { model: "m", retries: 1 });

  const result = await client.choice({ state: "x", instructions: "y", options: CEFR });
  assert.equal(result.length, 6);
  assert.equal(calls.length, 2);
});

test("does not retry a validation error", async () => {
  const { ai, calls } = fakeAi(() => {
    throw new Error(INVALID_REQUEST_ERROR);
  });
  const client = new ClefClient(ai, { model: "m", retries: 2 });

  await assert.rejects(
    client.choice({ state: "x", instructions: "y", options: CEFR }),
    /invalid_request/,
  );
  assert.equal(calls.length, 1);
});

test("rejects malformed responses with a useful message", async () => {
  const missingQuestion = new ClefClient(fakeAi(() => ({ answers: {} })).ai, { model: "m", retries: 0 });
  await assert.rejects(
    missingQuestion.choice({ state: "x", instructions: "y", options: CEFR }),
    /no answer/,
  );

  const missingLabel = new ClefClient(fakeAi(() => CHOICE_RESPONSE).ai, { model: "m", retries: 0 });
  await assert.rejects(
    missingLabel.choice({ state: "x", instructions: "y", options: ["A1", "ZZ"] }),
    /missing a probability for "ZZ"/,
  );
});

test("times out a call that never returns", async () => {
  const { ai } = fakeAi(() => new Promise(() => {}));
  const client = new ClefClient(ai, { model: "m", retries: 0, timeoutMs: 20 });

  await assert.rejects(
    client.choice({ state: "x", instructions: "y", options: CEFR }),
    /Timed out after 20 ms/,
  );
});
