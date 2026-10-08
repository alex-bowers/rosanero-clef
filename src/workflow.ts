// Only the Workers runtime has this module, so nothing the tests import may import this file.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { dailySteps } from "./daily.ts";
import { D1Store } from "./db.ts";
import { runStep } from "./jobs.ts";
import type { StepResult } from "./jobs.ts";
import type { Env } from "./types.ts";

export interface CrawlParams {
  runId: number;
}

/**
 * No retries: each step already records its own failure and the next one still runs, and a
 * retried ingest would fetch the news site again. Pressing the button again picks up whatever
 * did not finish.
 */
const ONCE = { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" } as const;

/** Runs the work behind the "Fetch new sentences" button, outside the request that started it. */
export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: { payload: CrawlParams }, step: WorkflowStepLike): Promise<StepResult[]> {
    const { runId } = event.payload;
    const store = new D1Store(this.env.DB);
    const results: StepResult[] = [];
    for (const [name, work] of dailySteps(this.env, store)) {
      results.push(
        await step.do(name, ONCE, async () => {
          await store.markCrawlStep(runId, name);
          return runStep([name, work]);
        }),
      );
    }
    await step.do("Finish", () => store.finishCrawlRun(runId, "done", results));
    return results;
  }
}

interface WorkflowStepLike {
  do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
