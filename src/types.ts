/** One probability per allowed option, in the order the options were asked. */
export type Distribution = { label: string; probability: number }[];

export interface DecisionClient {
  /** `descriptions` maps an option to what it means; it helps the model, so supply it where you can. */
  choice(opts: {
    state: unknown;
    instructions: string;
    options: string[];
    descriptions?: Record<string, string>;
  }): Promise<Distribution>;
  /** Levels are 0-indexed (labels "0" to `levels - 1`), matching Clef. `descriptions` is one per level. */
  score(opts: {
    state: unknown;
    instructions: string;
    levels: number;
    descriptions?: string[];
  }): Promise<Distribution>;
}

export interface ExplainInput {
  italian: string;
  reference: string;
  attempt: string;
  verdict: string;
}

export interface LlmClient {
  translate(italian: string[]): Promise<string[]>;
  explain(input: ExplainInput): Promise<string>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  /** Runs the statements in order as one transaction. */
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

/** Minimal structural bindings, so no @cloudflare/workers-types dependency is needed yet. */
export interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Clef model that rates chunk difficulty at ingest. */
  DECISION_MODEL: string;
  /** Clef model that scores translation attempts. */
  SCORING_MODEL: string;
  LLM_MODEL: string;
  CONFIDENCE_THRESHOLD: string;
  /** Request limits. Each is optional and falls back to a default when missing or invalid. */
  ATTEMPTS_PER_MINUTE?: string;
  EXPLAINS_PER_MINUTE?: string;
  DAILY_ATTEMPT_CAP?: string;
  DAILY_EXPLAIN_CAP?: string;
}
