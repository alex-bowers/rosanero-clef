import { tidyAttempt } from "./normalise.ts";
import { CEFR_LEVELS, summariseRating } from "./rating.ts";
import { needsExplanation, scoreAttempt } from "./scoring.ts";
import type { DecisionClient, Distribution, LlmClient } from "./types.ts";

const MAX_BODY_BYTES = 4096;
const MAX_ATTEMPT_CHARS = 1000;
const MAX_DAILY_CHUNK_CAP = 40;

export interface PracticeChunk {
  id: number;
  italian: string;
  source: { title: string; url: string };
  cefrDistribution: Distribution;
}

export interface NewAttempt {
  chunkId: number;
  attemptText: string;
  verdict: Distribution;
  verdictTop: string;
  fluencyScore: number;
  confidence: number;
  needsExplanation: boolean;
}

export interface AttemptForExplanation {
  id: number;
  italian: string;
  reference: string;
  attemptText: string;
  verdictTop: string;
  /** The stored explanation, or null if none has been written yet. */
  explanation: string | null;
}

export interface HistoryEntry {
  id: number;
  /** ISO 8601, UTC. */
  createdAt: string;
  italian: string;
  attempt: string;
  verdictTop: string;
  confidence: number;
  fluencyScore: number;
  needsExplanation: boolean;
  reference: string;
  explanation: string | null;
}

export interface Settings {
  targetLevel: string;
  /** CEFR levels either side of the target that are still shown. */
  levelRange: number;
  dailyChunkCap: number;
}

export interface CallRow {
  purpose: string;
  model: string;
  ok: boolean;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CallSummary {
  purpose: string;
  model: string;
  calls: number;
  failures: number;
  /** Over successful calls only. */
  medianMs: number | null;
  p95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface Limits {
  attemptsPerMinute: number;
  explainsPerMinute: number;
  dailyAttempts: number;
  dailyExplains: number;
}

export interface PracticeStore {
  settings(): Promise<Settings>;
  updateSettings(changes: Partial<Settings>): Promise<Settings>;
  /** Prefers chunks with the fewest attempts, then picks at random. */
  nextChunk(levels: string[]): Promise<PracticeChunk | null>;
  chunkToMark(id: number): Promise<{ id: number; italian: string; reference: string } | null>;
  saveAttempt(attempt: NewAttempt): Promise<number>;
  attemptToExplain(id: number): Promise<AttemptForExplanation | null>;
  /** Keeps the first explanation if two requests race. */
  saveExplanation(attemptId: number, text: string, model: string): Promise<void>;
  recentAttempts(limit: number): Promise<HistoryEntry[]>;
  logRequest(route: string): Promise<void>;
  requestsInLastSeconds(route: string, seconds: number): Promise<number>;
  requestsToday(route: string): Promise<number>;
  usageCalls(days: number): Promise<CallRow[]>;
}

export interface ApiDeps {
  store: PracticeStore;
  decision: DecisionClient;
  llm: LlmClient;
  /** Recorded with each stored explanation. */
  llmModel: string;
  confidenceThreshold: number;
  limits: Limits;
}

/** Returns null for paths this module does not handle. */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response | null> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/api/chunks/next":
      return request.method === "GET" ? nextChunk(url, deps) : methodNotAllowed("GET");
    case "/api/attempt":
      return request.method === "POST" ? submitAttempt(request, deps) : methodNotAllowed("POST");
    case "/api/explain":
      return request.method === "POST" ? explain(request, deps) : methodNotAllowed("POST");
    case "/api/history":
      return request.method === "GET" ? history(url, deps) : methodNotAllowed("GET");
    case "/api/usage":
      return request.method === "GET" ? usage(url, deps) : methodNotAllowed("GET");
    case "/api/settings":
      if (request.method === "GET") return json(await deps.store.settings());
      return request.method === "PUT" ? updateSettings(request, deps) : methodNotAllowed("GET, PUT");
    default:
      return null;
  }
}

async function nextChunk(url: URL, deps: ApiDeps): Promise<Response> {
  const settings = await deps.store.settings();
  const level = url.searchParams.get("level") ?? settings.targetLevel;
  if (!(CEFR_LEVELS as readonly string[]).includes(level)) {
    return json({ error: `level must be one of ${CEFR_LEVELS.join(", ")}` }, 400);
  }
  const range = Number(url.searchParams.get("range") ?? settings.levelRange);
  if (!Number.isInteger(range) || range < 0 || range > 5) {
    return json({ error: "range must be a whole number from 0 to 5" }, 400);
  }

  const chunk = await deps.store.nextChunk(levelsWithin(level, range));
  if (!chunk) return json({ error: "No chunks are available at that level yet" }, 404);

  // The reference translation is deliberately left out until after an attempt.
  return json({
    id: chunk.id,
    italian: chunk.italian,
    source: chunk.source,
    cefr: { ...summariseRating(chunk.cefrDistribution), distribution: chunk.cefrDistribution },
  });
}

async function submitAttempt(request: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await readJsonBody(request);
  if ("error" in parsed) return parsed.error;

  const { chunkId, attempt } = parsed.body;
  if (!isPositiveInteger(chunkId)) return json({ error: "chunkId must be a whole number" }, 400);
  if (typeof attempt !== "string" || attempt.trim() === "") {
    return json({ error: "attempt must be a non-empty string" }, 400);
  }
  if (attempt.length > MAX_ATTEMPT_CHARS) {
    return json({ error: `attempt must be at most ${MAX_ATTEMPT_CHARS} characters` }, 400);
  }

  const chunk = await deps.store.chunkToMark(chunkId);
  if (!chunk) return json({ error: "That chunk was not found" }, 404);

  const limited = await takeRequest("attempt", deps);
  if (limited) return limited;

  let score;
  try {
    score = await scoreAttempt(deps.decision, {
      italian: chunk.italian,
      reference: chunk.reference,
      attempt: tidyAttempt(attempt),
    });
  } catch (error) {
    console.error(`Scoring failed for chunk ${chunkId}: ${String(error)}`);
    return json({ error: "The scorer is unavailable. Please try again." }, 502);
  }

  const explain = needsExplanation(score.verdictTop, score.confidence, deps.confidenceThreshold);
  const attemptId = await deps.store.saveAttempt({
    chunkId,
    attemptText: attempt.trim(),
    verdict: score.verdict,
    verdictTop: score.verdictTop,
    fluencyScore: score.fluencyScore,
    confidence: score.confidence,
    needsExplanation: explain,
  });

  return json({
    attemptId,
    verdict: { top: score.verdictTop, confidence: score.confidence, distribution: score.verdict },
    fluency: { score: score.fluencyScore, outOf: 4 },
    needsExplanation: explain,
    italian: chunk.italian,
    reference: chunk.reference,
  });
}

/** The LLM runs only here, on request, and each attempt is explained at most once. */
async function explain(request: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await readJsonBody(request);
  if ("error" in parsed) return parsed.error;

  const { attemptId } = parsed.body;
  if (!isPositiveInteger(attemptId)) return json({ error: "attemptId must be a whole number" }, 400);

  const attempt = await deps.store.attemptToExplain(attemptId);
  if (!attempt) return json({ error: "That attempt was not found" }, 404);
  if (attempt.explanation) return json({ text: attempt.explanation, cached: true });

  const limited = await takeRequest("explain", deps);
  if (limited) return limited;

  let text: string;
  try {
    text = await deps.llm.explain({
      italian: attempt.italian,
      reference: attempt.reference,
      attempt: attempt.attemptText,
      verdict: attempt.verdictTop,
    });
  } catch (error) {
    console.error(`Explanation failed for attempt ${attemptId}: ${String(error)}`);
    return json({ error: "The explanation is unavailable. Please try again." }, 502);
  }

  await deps.store.saveExplanation(attemptId, text, deps.llmModel);
  const stored = await deps.store.attemptToExplain(attemptId);
  return json({ text: stored?.explanation ?? text, cached: false });
}

async function history(url: URL, deps: ApiDeps): Promise<Response> {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return json({ error: "limit must be a whole number from 1 to 50" }, 400);
  }
  return json({ attempts: await deps.store.recentAttempts(limit) });
}

async function updateSettings(request: Request, deps: ApiDeps): Promise<Response> {
  const parsed = await readJsonBody(request);
  if ("error" in parsed) return parsed.error;

  const { targetLevel, levelRange, dailyChunkCap } = parsed.body;
  const changes: Partial<Settings> = {};

  if (targetLevel !== undefined) {
    if (typeof targetLevel !== "string" || !(CEFR_LEVELS as readonly string[]).includes(targetLevel)) {
      return json({ error: `targetLevel must be one of ${CEFR_LEVELS.join(", ")}` }, 400);
    }
    changes.targetLevel = targetLevel;
  }
  if (levelRange !== undefined) {
    if (typeof levelRange !== "number" || !Number.isInteger(levelRange) || levelRange < 0 || levelRange > 5) {
      return json({ error: "levelRange must be a whole number from 0 to 5" }, 400);
    }
    changes.levelRange = levelRange;
  }
  if (dailyChunkCap !== undefined) {
    if (
      typeof dailyChunkCap !== "number" ||
      !Number.isInteger(dailyChunkCap) ||
      dailyChunkCap < 0 ||
      dailyChunkCap > MAX_DAILY_CHUNK_CAP
    ) {
      return json({ error: `dailyChunkCap must be a whole number from 0 to ${MAX_DAILY_CHUNK_CAP}` }, 400);
    }
    changes.dailyChunkCap = dailyChunkCap;
  }
  if (Object.keys(changes).length === 0) {
    return json({ error: "Send at least one of targetLevel, levelRange or dailyChunkCap" }, 400);
  }

  return json(await deps.store.updateSettings(changes));
}

/**
 * Counts one accepted request against the per-minute and daily limits. A request that later
 * fails at the AI service still counts, because it may have cost something. The check and the
 * insert are separate statements, so two requests at the same instant could pass together.
 */
async function takeRequest(route: "attempt" | "explain", deps: ApiDeps): Promise<Response | null> {
  const perMinute = route === "attempt" ? deps.limits.attemptsPerMinute : deps.limits.explainsPerMinute;
  const daily = route === "attempt" ? deps.limits.dailyAttempts : deps.limits.dailyExplains;
  const noun = route === "attempt" ? "attempts" : "explanations";

  if ((await deps.store.requestsToday(route)) >= daily) {
    return tooManyRequests(`You have reached today's limit of ${daily} ${noun}. It resets at midnight UTC.`, secondsUntilUtcMidnight());
  }
  if ((await deps.store.requestsInLastSeconds(route, 60)) >= perMinute) {
    return tooManyRequests(`That is more than ${perMinute} ${noun} a minute. Wait a moment and try again.`, 60);
  }
  await deps.store.logRequest(route);
  return null;
}

async function usage(url: URL, deps: ApiDeps): Promise<Response> {
  const days = Number(url.searchParams.get("days") ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return json({ error: "days must be a whole number from 1 to 90" }, 400);
  }
  const [attemptsToday, explainsToday, calls] = await Promise.all([
    deps.store.requestsToday("attempt"),
    deps.store.requestsToday("explain"),
    deps.store.usageCalls(days),
  ]);
  return json({
    days,
    today: {
      attempts: { used: attemptsToday, limit: deps.limits.dailyAttempts },
      explanations: { used: explainsToday, limit: deps.limits.dailyExplains },
    },
    calls: summariseCalls(calls),
  });
}

/** Groups calls by purpose and model, with latency percentiles over the successful ones. */
export function summariseCalls(rows: CallRow[]): CallSummary[] {
  const groups = new Map<string, CallRow[]>();
  for (const row of rows) {
    const key = `${row.purpose}\u0000${row.model}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()]
    .map((group) => {
      const durations = group.filter((r) => r.ok).map((r) => r.durationMs).sort((a, b) => a - b);
      return {
        purpose: group[0].purpose,
        model: group[0].model,
        calls: group.length,
        failures: group.filter((r) => !r.ok).length,
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        inputTokens: group.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
        outputTokens: group.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
      };
    })
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || a.model.localeCompare(b.model));
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function tooManyRequests(message: string, retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: {
      "retry-after": String(retryAfterSeconds),
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The target level and its neighbours, for example B1 with a range of 1 gives A2, B1 and B2. */
export function levelsWithin(target: string, range: number): string[] {
  const index = CEFR_LEVELS.indexOf(target as (typeof CEFR_LEVELS)[number]);
  return CEFR_LEVELS.slice(Math.max(0, index - range), index + range + 1);
}

async function readJsonBody(
  request: Request,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { error: json({ error: "The request is too large" }, 413) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: json({ error: "The request body must be valid JSON" }, 400) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: json({ error: "The request body must be a JSON object" }, 400) };
  }
  return { body: value as Record<string, unknown> };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { allow: allowed, "content-type": "application/json", "cache-control": "no-store" },
  });
}
