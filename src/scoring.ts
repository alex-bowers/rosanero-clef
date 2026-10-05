import type { DecisionClient, Distribution } from "./types.ts";

export const VERDICTS = ["fully_correct", "minor_issue", "partly_correct", "wrong"] as const;

export const MEANING_INSTRUCTIONS =
  "You are marking an English-speaking learner's translation of an Italian text. " +
  "Compare the attempt with the Italian and with the reference translation. " +
  "The reference is one acceptable translation, not the only one: accept any other wording that keeps the meaning of the Italian. " +
  "Judge meaning only, and ignore spelling, punctuation and capital letters. " +
  "If the reference and the Italian disagree, trust the Italian.";

export const MEANING_DESCRIPTIONS: Record<string, string> = {
  fully_correct: "Everything in the Italian is conveyed correctly, in any wording",
  minor_issue: "The meaning is conveyed, but with a small slip such as a wrong tense, a less precise word or a changed degree, that does not change the main point",
  partly_correct: "Part of the meaning is missing, added or wrong",
  wrong: "Mostly wrong, unrelated or without meaning",
};

export const FLUENCY_INSTRUCTIONS =
  "Rate how natural and grammatical the English attempt reads, whether or not it matches the Italian. Ignore capital letters and punctuation.";

export const FLUENCY_DESCRIPTIONS = [
  "Unreadable",
  "Poor: many errors",
  "Acceptable: understandable but awkward",
  "Good: only minor slips",
  "Natural: reads like fluent English",
];

export interface AttemptInput {
  italian: string;
  reference: string;
  attempt: string;
}

export interface AttemptScore {
  verdict: Distribution;
  verdictTop: string;
  /** Probability of the top verdict. */
  confidence: number;
  fluency: Distribution;
  /** Probability-weighted fluency on a 0 to 4 scale. */
  fluencyScore: number;
}

export async function scoreAttempt(
  decision: DecisionClient,
  input: AttemptInput,
): Promise<AttemptScore> {
  const state = { italian: input.italian, reference: input.reference, attempt: input.attempt };
  const [verdict, fluency] = await Promise.all([
    decision.choice({
      state,
      instructions: MEANING_INSTRUCTIONS,
      options: [...VERDICTS],
      descriptions: MEANING_DESCRIPTIONS,
    }),
    decision.score({
      state,
      instructions: FLUENCY_INSTRUCTIONS,
      levels: FLUENCY_DESCRIPTIONS.length,
      descriptions: FLUENCY_DESCRIPTIONS,
    }),
  ]);

  const total = verdict.reduce((sum, d) => sum + d.probability, 0);
  const top = verdict.reduce((best, d) => (d.probability > best.probability ? d : best));
  const fluencyTotal = fluency.reduce((sum, d) => sum + d.probability, 0);
  if (total <= 0 || fluencyTotal <= 0) throw new Error("Clef returned no probability mass");

  return {
    verdict,
    verdictTop: top.label,
    confidence: top.probability / total,
    fluency,
    fluencyScore: fluency.reduce((sum, d, i) => sum + i * d.probability, 0) / fluencyTotal,
  };
}

const NEEDS_HELP = new Set<string>(["partly_correct", "wrong"]);

/** The Explain button appears when the verdict is poor or the scorer is unsure. */
export function needsExplanation(
  verdictTop: string,
  confidence: number,
  threshold: number,
): boolean {
  return NEEDS_HELP.has(verdictTop) || confidence < threshold;
}
