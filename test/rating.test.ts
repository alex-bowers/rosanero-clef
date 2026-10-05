import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseRating } from "../src/rating.ts";

const dist = (probs: number[]) =>
  ["A1", "A2", "B1", "B2", "C1", "C2"].map((label, i) => ({ label, probability: probs[i] }));

test("picks the top level, runner-up and confidence", () => {
  const result = summariseRating(dist([0, 0.1, 0.62, 0.25, 0.03, 0]));
  assert.equal(result.top, "B1");
  assert.equal(result.runnerUp, "B2");
  assert.ok(Math.abs(result.confidence - 0.62) < 1e-9);
});

test("expected level is probability-weighted", () => {
  const result = summariseRating(dist([0, 0, 0.5, 0.5, 0, 0]));
  assert.equal(result.expected, 2.5);
});

test("normalises distributions that do not sum to one (rounded output)", () => {
  const result = summariseRating(dist([0, 0, 0.3333, 0.3333, 0.3333, 0]));
  assert.ok(Math.abs(result.expected - 3) < 1e-9);
});

test("rejects empty and unknown-label distributions", () => {
  assert.throws(() => summariseRating([]));
  assert.throws(() => summariseRating([{ label: "D9", probability: 1 }]));
});
