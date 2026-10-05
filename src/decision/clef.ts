import { sleep, withTimeout } from "../async.ts";
import { lateCall, metered } from "../metering.ts";
import type { CallListener } from "../metering.ts";
import type { DecisionClient, Distribution, Env } from "../types.ts";

export interface ClefOptions {
  model: string;
  /** Extra attempts after the first call fails with a non-validation error. */
  retries?: number;
  timeoutMs?: number;
  /** Told about every call, including failed attempts that are then retried. */
  onCall?: CallListener;
}

const QUESTION_ID = "q";

export class ClefClient implements DecisionClient {
  private readonly ai: Env["AI"];
  private readonly model: string;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly onCall: CallListener | undefined;

  constructor(ai: Env["AI"], options: ClefOptions) {
    this.ai = ai;
    this.model = options.model;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onCall = options.onCall;
  }

  async choice(opts: {
    state: unknown;
    instructions: string;
    options: string[];
    descriptions?: Record<string, string>;
  }): Promise<Distribution> {
    const criteria = Object.fromEntries(
      opts.options.map((option) => [option, opts.descriptions?.[option] ?? option]),
    );
    const answer = await this.ask(opts.state, {
      type: "choice",
      instructions: opts.instructions,
      criteria,
    });
    return toDistribution(answer, opts.options);
  }

  async score(opts: {
    state: unknown;
    instructions: string;
    levels: number;
    descriptions?: string[];
  }): Promise<Distribution> {
    const labels = Array.from({ length: opts.levels }, (_, i) => String(i));
    const criteria = labels.map((_, i) => opts.descriptions?.[i] ?? `Level ${i}`);
    const answer = await this.ask(opts.state, {
      type: "score",
      instructions: opts.instructions,
      criteria,
    });
    return toDistribution(answer, labels);
  }

  private async ask(state: unknown, question: Record<string, unknown>): Promise<unknown> {
    const body = { state, questions: { [QUESTION_ID]: question } };
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await metered(this.model, this.onCall, () =>
          withTimeout(this.ai.run(this.model, body), this.timeoutMs, (late) =>
            lateCall(this.onCall, this.model, late, this.timeoutMs),
          ),
        );
        const answers = (result as { answers?: Record<string, unknown> } | null)?.answers;
        if (!answers || !(QUESTION_ID in answers)) {
          throw new Error(`Clef response has no answer for "${QUESTION_ID}"`);
        }
        return answers[QUESTION_ID];
      } catch (error) {
        lastError = error;
        if (isValidationError(error)) break;
        if (attempt < this.retries) await sleep(500 * 2 ** attempt);
      }
    }
    throw new Error(`Clef call to ${this.model} failed: ${describe(lastError)}`, {
      cause: lastError,
    });
  }
}

/** Reads `probabilities` and returns them in the order the labels were asked. */
function toDistribution(answer: unknown, labels: string[]): Distribution {
  const probabilities = (answer as { probabilities?: Record<string, unknown> } | null)
    ?.probabilities;
  if (!probabilities) throw new Error("Clef answer has no probabilities");

  const distribution = labels.map((label) => {
    const probability = probabilities[label];
    if (typeof probability !== "number") {
      throw new Error(`Clef answer is missing a probability for "${label}"`);
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Clef answer has an invalid probability for "${label}": ${probability}`);
    }
    return { label, probability };
  });
  if (distribution.every((entry) => entry.probability === 0)) {
    throw new Error("Clef answer has no positive probability");
  }
  return distribution;
}

/** Bad requests will not improve on retry. */
function isValidationError(error: unknown): boolean {
  return describe(error).includes("invalid_request");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

