import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/eval/calibration.ts";

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];

/** A distribution with `top` taking `share` and the rest split evenly. */
function peaked(top: string, share: number) {
  const rest = (1 - share) / 5;
  return LEVELS.map((label) => ({ label, probability: label === top ? share : rest }));
}

test("accuracy, within-one-level and confusion counts", () => {
  const report = evaluate([
    { truth: "B1", distribution: peaked("B1", 0.8) }, // exact
    { truth: "B1", distribution: peaked("B2", 0.8) }, // one off
    { truth: "A1", distribution: peaked("C1", 0.8) }, // far off
  ]);
  assert.equal(report.count, 3);
  assert.ok(Math.abs(report.accuracy - 1 / 3) < 1e-9);
  assert.ok(Math.abs(report.withinOneLevel - 2 / 3) < 1e-9);
  assert.equal(report.confusion.B1.B1, 1);
  assert.equal(report.confusion.B1.B2, 1);
  assert.equal(report.confusion.A1.C1, 1);
});

test("a perfectly calibrated set has near-zero calibration error", () => {
  // Four predictions at 0.75 confidence, three of them right.
  const report = evaluate([
    { truth: "B1", distribution: peaked("B1", 0.75) },
    { truth: "B1", distribution: peaked("B1", 0.75) },
    { truth: "B1", distribution: peaked("B1", 0.75) },
    { truth: "B1", distribution: peaked("B2", 0.75) },
  ]);
  assert.ok(report.expectedCalibrationError < 1e-9);
  const bin = report.bins.find((b) => b.count > 0)!;
  assert.equal(bin.count, 4);
  assert.equal(bin.accuracy, 0.75);
});

test("an overconfident set shows a large calibration error", () => {
  const report = evaluate(Array.from({ length: 4 }, () => ({ truth: "A1", distribution: peaked("C2", 0.95) })));
  assert.ok(report.expectedCalibrationError > 0.9);
});

test("mean absolute error uses the probability-weighted level", () => {
  const report = evaluate([{ truth: "A1", distribution: peaked("A1", 1) }]);
  assert.equal(report.meanAbsoluteError, 0);
});

test("rejects empty input and unknown labels", () => {
  assert.throws(() => evaluate([]));
  assert.throws(() => evaluate([{ truth: "Z9", distribution: peaked("B1", 0.8) }]));
});
