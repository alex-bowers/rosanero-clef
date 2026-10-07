export type Step = [name: string, run: () => Promise<unknown>];

export interface StepResult {
  name: string;
  ok: boolean;
  /** What the step returned, for example the ingest summary. */
  output?: unknown;
  error?: string;
}

/** Runs one step. A step that throws is logged and reported as failed rather than thrown. */
export async function runStep([name, run]: Step): Promise<StepResult> {
  try {
    const output = await run();
    console.log(`${name} finished`, JSON.stringify(output));
    return output === undefined ? { name, ok: true } : { name, ok: true, output };
  } catch (error) {
    console.error(`${name} failed: ${String(error)}`);
    return { name, ok: false, error: String(error) };
  }
}

/**
 * Runs each step in turn. A step that throws is logged and the next one still runs, so a
 * failed ingest does not stop ratings and translations that are already waiting.
 */
export async function runSteps(steps: Step[]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) results.push(await runStep(step));
  return results;
}
