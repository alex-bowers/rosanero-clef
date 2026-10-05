import type { Distribution } from "./types.ts";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

export const CEFR_INSTRUCTIONS =
  "Rate the reading difficulty of this Italian text for an English-speaking learner of Italian, using the CEFR scale.";

export const CEFR_DESCRIPTIONS: Record<string, string> = {
  A1: "Beginner: very common words and short, simple sentences",
  A2: "Elementary: everyday vocabulary, simple tenses and connectors",
  B1: "Intermediate: clear standard language on familiar topics, some subordinate clauses",
  B2: "Upper intermediate: complex texts on abstract topics, a wide vocabulary",
  C1: "Advanced: long, demanding texts with idiom and implied meaning",
  C2: "Proficient: highly nuanced, literary or specialist language",
};

export interface RatingSummary {
  top: string;
  confidence: number;
  /** Probability-weighted level on a 0 (A1) to 5 (C2) scale. */
  expected: number;
  /** The next most likely level, shown as "could be …" in the UI. */
  runnerUp: string | null;
}

export function summariseRating(distribution: Distribution): RatingSummary {
  const total = distribution.reduce((sum, d) => sum + d.probability, 0);
  if (distribution.length === 0 || total <= 0) {
    throw new Error("Cannot summarise an empty or zero-probability distribution");
  }

  const ranked = [...distribution].sort((a, b) => b.probability - a.probability);
  const expected =
    distribution.reduce((sum, d) => {
      const index = CEFR_LEVELS.indexOf(d.label as (typeof CEFR_LEVELS)[number]);
      if (index === -1) throw new Error(`Unknown CEFR level: ${d.label}`);
      return sum + index * d.probability;
    }, 0) / total;

  return {
    top: ranked[0].label,
    confidence: ranked[0].probability / total,
    expected,
    runnerUp: ranked[1]?.label ?? null,
  };
}
