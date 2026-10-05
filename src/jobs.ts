export type Step = [name: string, run: () => Promise<unknown>];

export interface StepResult {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * Runs each step in turn. A step that throws is logged and the next one still runs, so a
 * failed ingest does not stop ratings and translations that are already waiting.
 */
export async function runSteps(steps: Step[]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [name, run] of steps) {
    try {
      console.log(`${name} finished`, JSON.stringify(await run()));
      results.push({ name, ok: true });
    } catch (error) {
      console.error(`${name} failed: ${String(error)}`);
      results.push({ name, ok: false, error: String(error) });
    }
  }
  return results;
}
