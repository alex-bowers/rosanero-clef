import type { StepResult } from "./jobs.ts";

/** A run still marked running after this long is treated as lost, so the button never stays stuck. */
export const STALE_AFTER_MINUTES = 30;
/** How long a new run may take to show up in the Workflow before its status is worth checking. */
const INSTANCE_GRACE_SECONDS = 60;

export interface CrawlRun {
  id: number;
  status: "running" | "done" | "failed";
  step: string | null;
  instanceId: string | null;
  results: StepResult[] | null;
  /** ISO 8601, UTC. */
  startedAt: string;
  finishedAt: string | null;
}

export interface CrawlStore {
  dailyChunkCap(): Promise<number>;
  chunksAddedToday(): Promise<number>;
  /** Chunks still waiting for a rating or a reference translation. */
  pendingChunks(): Promise<number>;
  latestCrawlRun(): Promise<CrawlRun | null>;
  /** Returns the new run's id, or null if another run is already going. */
  beginCrawlRun(): Promise<number | null>;
  setCrawlInstance(runId: number, instanceId: string): Promise<void>;
  markCrawlStep(runId: number, step: string): Promise<void>;
  finishCrawlRun(runId: number, status: "done" | "failed", results: StepResult[] | null): Promise<void>;
}

/** The Workflow that does the work, kept behind an interface so the API can be tested without it. */
export interface CrawlWorkflow {
  /** Starts a run and returns its instance id. */
  start(runId: number): Promise<string>;
  /** The Workflow's own status for an instance, for example "running", "errored" or "complete". */
  state(instanceId: string): Promise<string>;
}

export interface CrawlDeps {
  store: CrawlStore;
  workflow: CrawlWorkflow;
}

export interface CrawlStatus {
  run: {
    status: CrawlRun["status"];
    step: string | null;
    startedAt: string;
    finishedAt: string | null;
    /** Whether every step finished; false when one failed and pressing again would retry it. */
    complete: boolean;
    chunksAdded: number;
  } | null;
  today: { added: number; cap: number; pending: number };
  canStart: boolean;
  /** Why the button is off: "running", "paused" (cap is 0) or "limit" (today's cap is reached). */
  reason: "running" | "paused" | "limit" | null;
}

/** Returns null for paths this module does not handle. */
export async function handleCrawl(request: Request, deps: CrawlDeps): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/crawl") return null;
  if (request.method === "GET") return json(await crawlStatus(deps));
  if (request.method === "POST") return startCrawl(deps);
  return json({ error: "Method not allowed" }, 405, { allow: "GET, POST" });
}

async function startCrawl(deps: CrawlDeps): Promise<Response> {
  const before = await crawlStatus(deps);
  if (!before.canStart) {
    const error =
      before.reason === "running"
        ? "New sentences are already being fetched."
        : before.reason === "paused"
          ? "New sentences are paused. Set a daily number above 0 in Settings."
          : "Today's new sentences are already in. More tomorrow.";
    return json({ error, ...before }, 409);
  }

  const runId = await deps.store.beginCrawlRun();
  // Another press got in between the check and the insert; show that run instead.
  if (runId === null) return json({ error: "New sentences are already being fetched.", ...(await crawlStatus(deps)) }, 409);

  try {
    await deps.store.setCrawlInstance(runId, await deps.workflow.start(runId));
  } catch (error) {
    console.error(`Could not start the crawl workflow: ${String(error)}`);
    await deps.store.finishCrawlRun(runId, "failed", null);
    return json({ error: "Could not start fetching new sentences. Please try again." }, 503);
  }
  return json(await crawlStatus(deps), 202);
}

export async function crawlStatus(deps: CrawlDeps): Promise<CrawlStatus> {
  const { store } = deps;
  let run = await store.latestCrawlRun();
  if (run?.status === "running" && (await workflowGaveUp(run, deps.workflow))) {
    await store.finishCrawlRun(run.id, "failed", null);
    run = await store.latestCrawlRun();
  }

  const [cap, added, pending] = await Promise.all([
    store.dailyChunkCap(),
    store.chunksAddedToday(),
    store.pendingChunks(),
  ]);
  const reason =
    run?.status === "running" ? "running" : cap === 0 ? "paused" : added >= cap && pending === 0 ? "limit" : null;

  return {
    run: run && {
      status: run.status,
      step: run.step,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      complete: run.status === "done" && (run.results ?? []).every((result) => result.ok),
      chunksAdded: chunksAdded(run.results),
    },
    today: { added, cap, pending },
    canStart: reason === null,
    reason,
  };
}

/** True when the Workflow stopped without the run's final step marking it finished. */
async function workflowGaveUp(run: CrawlRun, workflow: CrawlWorkflow): Promise<boolean> {
  if (!run.instanceId) return false;
  if (Date.now() - Date.parse(run.startedAt) < INSTANCE_GRACE_SECONDS * 1000) return false;
  try {
    return ["errored", "terminated"].includes(await workflow.state(run.instanceId));
  } catch (error) {
    // The stale cut-off still catches a lost run, so a failed check is only logged.
    console.warn(`Could not check crawl instance ${run.instanceId}: ${String(error)}`);
    return false;
  }
}

function chunksAdded(results: StepResult[] | null): number {
  const ingest = results?.find((result) => result.name === "Ingest");
  const output = ingest?.output as { chunksAdded?: unknown } | undefined;
  return typeof output?.chunksAdded === "number" ? output.chunksAdded : 0;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}
