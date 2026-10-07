import type { D1Store } from "./db.ts";
import { ClefClient } from "./decision/clef.ts";
import { PoliteFetcher } from "./ingest/fetch.ts";
import { runIngest } from "./ingest/run.ts";
import type { Step } from "./jobs.ts";
import { WorkersAiLlmClient } from "./llm/workersai.ts";
import type { CallListener } from "./metering.ts";
import { runRating } from "./rate.ts";
import { runTranslation } from "./translate.ts";
import type { Env } from "./types.ts";

/**
 * The work behind the "Fetch new sentences" button: ingest, then rate and translate whatever is
 * waiting, then prune the logs. Each step reads what it needs when it runs, so a Workflow that
 * replays its run() after a restart builds the same list without repeating any work.
 */
export function dailySteps(env: Env, store: D1Store): Step[] {
  return [
    ["Ingest", () => runIngest({ store, fetcher: new PoliteFetcher() })],
    [
      "Rating",
      async () =>
        (await paused(store))
          ? skipped("Rating")
          : runRating({
              store,
              decision: new ClefClient(env.AI, { model: env.DECISION_MODEL, onCall: recordCalls(store, "rate") }),
            }),
    ],
    [
      "Translation",
      async () =>
        (await paused(store))
          ? skipped("Translation")
          : runTranslation({
              store,
              llm: new WorkersAiLlmClient(env.AI, { model: env.LLM_MODEL, onCall: recordCalls(store, "translate") }),
            }),
    ],
    ["Cleanup", () => store.pruneOldRows()],
  ];
}

/** A sentence cap of 0 is the app's AI pause switch: ingest, rating and translation all stand down. */
function paused(store: D1Store): Promise<boolean> {
  return store.dailyChunkCap().then(
    (cap) => cap === 0,
    (error) => {
      console.error(`Could not read the sentence cap, so AI steps are paused: ${String(error)}`);
      return true;
    },
  );
}

function skipped(step: string): Promise<void> {
  console.log(`${step} skipped: the daily sentence cap is 0.`);
  return Promise.resolve();
}

/** Logs each AI call and stores it, for latency and cost tracking. */
export function recordCalls(store: D1Store, purpose: string): CallListener {
  return (call) => {
    console.log(JSON.stringify({ event: "ai_call", purpose, ...call }));
    return store.recordCall(purpose, call);
  };
}
