import { CEFR_LEVELS } from "../rating.ts";
import type { Distribution } from "../types.ts";

export interface Prediction {
  truth: string;
  distribution: Distribution;
}

export interface CalibrationBin {
  from: number;
  to: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface Report {
  count: number;
  accuracy: number;
  /** Share of predictions that are the right label or the one next to it, in `levels` order. */
  withinOneLevel: number;
  /** Mean absolute gap between the probability-weighted position and the true position. */
  meanAbsoluteError: number;
  /** Mean gap between confidence and accuracy across bins, weighted by bin size. */
  expectedCalibrationError: number;
  /** confusion[truth][predicted] counts. */
  confusion: Record<string, Record<string, number>>;
  bins: CalibrationBin[];
}

const BIN_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0000001];

/** `levels` is the ordered label set; it defaults to the CEFR scale. */
export function evaluate(
  predictions: Prediction[],
  levels: readonly string[] = CEFR_LEVELS,
): Report {
  if (predictions.length === 0) throw new Error("No predictions to evaluate");

  const confusion = Object.fromEntries(
    levels.map((truth) => [truth, Object.fromEntries(levels.map((p) => [p, 0]))]),
  );
  const binned = BIN_EDGES.slice(0, -1).map(() => ({ count: 0, confidence: 0, correct: 0 }));
  let correct = 0;
  let withinOne = 0;
  let absoluteError = 0;

  for (const { truth, distribution } of predictions) {
    const truthIndex = levels.indexOf(truth);
    if (truthIndex === -1) throw new Error(`Unknown label: ${truth}`);

    const { top, confidence, expected } = summarise(distribution, levels);
    const predictedIndex = levels.indexOf(top);
    const isCorrect = predictedIndex === truthIndex;

    confusion[truth][top]++;
    if (isCorrect) correct++;
    if (Math.abs(predictedIndex - truthIndex) <= 1) withinOne++;
    absoluteError += Math.abs(expected - truthIndex);

    const bin = binned[BIN_EDGES.findIndex((edge, i) => confidence >= edge && confidence < BIN_EDGES[i + 1])];
    bin.count++;
    bin.confidence += confidence;
    if (isCorrect) bin.correct++;
  }

  const n = predictions.length;
  const bins = binned.map((bin, i) => ({
    from: BIN_EDGES[i],
    to: Math.min(BIN_EDGES[i + 1], 1),
    count: bin.count,
    meanConfidence: bin.count ? bin.confidence / bin.count : 0,
    accuracy: bin.count ? bin.correct / bin.count : 0,
  }));
  const expectedCalibrationError = bins.reduce(
    (sum, bin) => sum + (bin.count / n) * Math.abs(bin.accuracy - bin.meanConfidence),
    0,
  );

  return {
    count: n,
    accuracy: correct / n,
    withinOneLevel: withinOne / n,
    meanAbsoluteError: absoluteError / n,
    expectedCalibrationError,
    confusion,
    bins,
  };
}

function summarise(distribution: Distribution, levels: readonly string[]) {
  const total = distribution.reduce((sum, d) => sum + d.probability, 0);
  if (distribution.length === 0 || total <= 0) {
    throw new Error("Cannot summarise an empty or zero-probability distribution");
  }
  const top = distribution.reduce((best, d) => (d.probability > best.probability ? d : best));
  const expected =
    distribution.reduce((sum, d) => {
      const index = levels.indexOf(d.label);
      if (index === -1) throw new Error(`Unknown label: ${d.label}`);
      return sum + index * d.probability;
    }, 0) / total;
  return { top: top.label, confidence: top.probability / total, expected };
}
