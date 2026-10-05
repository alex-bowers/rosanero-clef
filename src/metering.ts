/** One call to Workers AI, as reported to a listener. */
export interface CallRecord {
  model: string;
  ok: boolean;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type CallListener = (call: CallRecord) => void | Promise<void>;

/**
 * Times one call and reports it, whether it succeeds or fails. A listener that throws is
 * logged and ignored, because logging must never break a request.
 */
export async function metered<T>(
  model: string,
  listener: CallListener | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await report(listener, { model, ok: false, durationMs: Date.now() - started, inputTokens: null, outputTokens: null });
    throw error;
  }
  await report(listener, { model, ok: true, durationMs: Date.now() - started, ...readUsage(result) });
  return result;
}

/**
 * Records a call whose result arrived after its timeout. The attempt itself was already
 * recorded as failed, so this adds the tokens that were spent; its duration is at least the timeout.
 */
export function lateCall(listener: CallListener | undefined, model: string, result: unknown, timeoutMs: number): void {
  void report(listener, { model, ok: true, durationMs: timeoutMs, ...readUsage(result) });
}

/** Clef reports input_tokens and output_tokens; text models use the OpenAI names. */
export function readUsage(result: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = (result as { usage?: Record<string, unknown> } | null)?.usage;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    inputTokens: number(usage?.input_tokens) ?? number(usage?.prompt_tokens),
    outputTokens: number(usage?.output_tokens) ?? number(usage?.completion_tokens),
  };
}

async function report(listener: CallListener | undefined, call: CallRecord): Promise<void> {
  if (!listener) return;
  try {
    await listener(call);
  } catch (error) {
    console.warn(`Could not record an AI call: ${String(error)}`);
  }
}
