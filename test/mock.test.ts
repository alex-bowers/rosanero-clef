import { test } from "node:test";
import assert from "node:assert/strict";
import { MockDecisionClient } from "../src/decision/mock.ts";
import { MockLlmClient } from "../src/llm/mock.ts";

const sum = (d: { probability: number }[]) => d.reduce((s, x) => s + x.probability, 0);

test("mock choice returns a normalised distribution in option order", async () => {
  const options = ["A1", "A2", "B1"];
  const result = await new MockDecisionClient().choice({ state: "x", instructions: "y", options });
  assert.deepEqual(result.map((r) => r.label), options);
  assert.ok(Math.abs(sum(result) - 1) < 1e-9);
});

test("mock score returns one entry per level", async () => {
  const result = await new MockDecisionClient().score({ state: "x", instructions: "y", levels: 5 });
  assert.equal(result.length, 5);
  assert.ok(Math.abs(sum(result) - 1) < 1e-9);
});

test("mock LLM translates one string per input", async () => {
  const result = await new MockLlmClient().translate(["ciao", "palermo"]);
  assert.equal(result.length, 2);
});
