import { handleApi } from "./api.ts";
import type { Limits } from "./api.ts";
import { D1Store } from "./db.ts";
import { ClefClient } from "./decision/clef.ts";
import { PoliteFetcher } from "./ingest/fetch.ts";
import { runIngest } from "./ingest/run.ts";
import { runSteps } from "./jobs.ts";
import { WorkersAiLlmClient } from "./llm/workersai.ts";
import type { CallListener } from "./metering.ts";
import { runRating } from "./rate.ts";
import { runTranslation } from "./translate.ts";
import type { Env } from "./types.ts";

const DEFAULT_LIMITS: Limits = {
  attemptsPerMinute: 10,
  explainsPerMinute: 5,
  dailyAttempts: 200,
  dailyExplains: 50,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      // Without this, an unexpected failure would show Cloudflare's own error page.
      console.error(`Unhandled error for ${request.method} ${new URL(request.url).pathname}: ${String(error)}`);
      return Response.json(
        { error: "Something went wrong on the server. Please try again." },
        { status: 500, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
      );
    }
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const store = new D1Store(env.DB);
    await runSteps([
      ["Ingest", () => runIngest({ store, fetcher: new PoliteFetcher() })],
      [
        "Rating",
        () =>
          runRating({
            store,
            decision: new ClefClient(env.AI, { model: env.DECISION_MODEL, onCall: recordCalls(store, "rate") }),
          }),
      ],
      [
        "Translation",
        () =>
          runTranslation({
            store,
            llm: new WorkersAiLlmClient(env.AI, { model: env.LLM_MODEL, onCall: recordCalls(store, "translate") }),
          }),
      ],
      ["Cleanup", () => store.pruneOldRows()],
    ]);
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    return Response.json({ ok: true, decisionModel: env.DECISION_MODEL });
  }
  if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  const store = new D1Store(env.DB);
  const response = await handleApi(request, {
    store,
    decision: new ClefClient(env.AI, {
      model: env.SCORING_MODEL,
      retries: 1,
      timeoutMs: 20_000,
      onCall: recordCalls(store, "score"),
    }),
    llm: new WorkersAiLlmClient(env.AI, {
      model: env.LLM_MODEL,
      retries: 1,
      timeoutMs: 30_000,
      onCall: recordCalls(store, "explain"),
    }),
    llmModel: env.LLM_MODEL,
    confidenceThreshold: Number(env.CONFIDENCE_THRESHOLD) || 0.45,
    limits: limitsFrom(env),
  });
  return response ?? Response.json({ error: "Not found" }, { status: 404 });
}

/** Logs each AI call and stores it, for latency and cost tracking. */
function recordCalls(store: D1Store, purpose: string): CallListener {
  return (call) => {
    console.log(JSON.stringify({ event: "ai_call", purpose, ...call }));
    return store.recordCall(purpose, call);
  };
}

export function limitsFrom(env: Pick<Env, "ATTEMPTS_PER_MINUTE" | "EXPLAINS_PER_MINUTE" | "DAILY_ATTEMPT_CAP" | "DAILY_EXPLAIN_CAP">): Limits {
  const whole = (value: string | undefined, fallback: number) => {
    const number = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isInteger(number) && number >= 0 ? number : fallback;
  };
  return {
    attemptsPerMinute: whole(env.ATTEMPTS_PER_MINUTE, DEFAULT_LIMITS.attemptsPerMinute),
    explainsPerMinute: whole(env.EXPLAINS_PER_MINUTE, DEFAULT_LIMITS.explainsPerMinute),
    dailyAttempts: whole(env.DAILY_ATTEMPT_CAP, DEFAULT_LIMITS.dailyAttempts),
    dailyExplains: whole(env.DAILY_EXPLAIN_CAP, DEFAULT_LIMITS.dailyExplains),
  };
}
