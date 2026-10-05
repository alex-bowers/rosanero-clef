import { test } from "node:test";
import assert from "node:assert/strict";
import { needsExplanation, scoreAttempt, VERDICTS } from "../src/scoring.ts";
import { MockDecisionClient } from "../src/decision/mock.ts";
import { evaluate } from "../src/eval/calibration.ts";
import type { DecisionClient } from "../src/types.ts";

test("poor verdicts always need an explanation", () => {
  assert.equal(needsExplanation("wrong", 0.99, 0.6), true);
  assert.equal(needsExplanation("partly_correct", 0.99, 0.6), true);
});

test("good verdicts need one only when the scorer is unsure", () => {
  assert.equal(needsExplanation("fully_correct", 0.9, 0.6), false);
  assert.equal(needsExplanation("minor_issue", 0.59, 0.6), true);
  assert.equal(needsExplanation("minor_issue", 0.6, 0.6), false);
});

test("scoreAttempt asks one meaning question and one fluency question about the same state", async () => {
  const asked: any[] = [];
  const inner = new MockDecisionClient({ topIndex: 0, topShare: 0.8 });
  const decision: DecisionClient = {
    choice: (opts) => (asked.push({ kind: "choice", ...opts }), inner.choice(opts)),
    score: (opts) => (asked.push({ kind: "score", ...opts }), inner.score(opts)),
  };

  const result = await scoreAttempt(decision, { italian: "Ciao.", reference: "Hello.", attempt: "hi" });

  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0].state, { italian: "Ciao.", reference: "Hello.", attempt: "hi" });
  assert.deepEqual(asked[1].state, asked[0].state);
  assert.deepEqual(asked[0].options, [...VERDICTS]);
  assert.equal(asked[1].levels, 5);
  assert.equal(asked[1].descriptions.length, 5);
  assert.equal(result.verdictTop, "fully_correct");
  assert.ok(Math.abs(result.confidence - 0.8) < 1e-9);
});

test("fluency score is the probability-weighted level from 0 to 4", async () => {
  const decision: DecisionClient = {
    choice: async ({ options }) => options.map((label, i) => ({ label, probability: i === 0 ? 1 : 0 })),
    score: async () => [
      { label: "0", probability: 0 },
      { label: "1", probability: 0 },
      { label: "2", probability: 0.5 },
      { label: "3", probability: 0.5 },
      { label: "4", probability: 0 },
    ],
  };
  const result = await scoreAttempt(decision, { italian: "a", reference: "b", attempt: "c" });
  assert.equal(result.fluencyScore, 2.5);
});

test("scoreAttempt rejects a response with no probability mass", async () => {
  const decision: DecisionClient = {
    choice: async ({ options }) => options.map((label) => ({ label, probability: 0 })),
    score: async () => [{ label: "0", probability: 1 }],
  };
  await assert.rejects(scoreAttempt(decision, { italian: "a", reference: "b", attempt: "c" }), /no probability mass/);
});

test("evaluate works with a custom label set such as the verdicts", () => {
  const peaked = (top: string) =>
    VERDICTS.map((label) => ({ label, probability: label === top ? 0.7 : 0.1 }));
  const report = evaluate(
    [
      { truth: "fully_correct", distribution: peaked("fully_correct") },
      { truth: "wrong", distribution: peaked("partly_correct") },
    ],
    VERDICTS,
  );
  assert.equal(report.accuracy, 0.5);
  assert.equal(report.withinOneLevel, 1, "partly_correct is next to wrong");
  assert.equal(report.confusion.wrong.partly_correct, 1);
});
