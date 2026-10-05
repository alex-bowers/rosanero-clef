import type {
  AttemptForExplanation,
  CallRow,
  HistoryEntry,
  NewAttempt,
  PracticeChunk,
  PracticeStore,
  Settings,
} from "./api.ts";
import type { Chunk } from "./ingest/chunk.ts";
import type { IngestStore, StoredArticle } from "./ingest/run.ts";
import type { CallRecord } from "./metering.ts";
import type { RatingStore, UnratedChunk } from "./rate.ts";
import type { RatingSummary } from "./rating.ts";
import type { TranslationStore, UntranslatedChunk } from "./translate.ts";
import type { D1Like, Distribution } from "./types.ts";

export class D1Store implements IngestStore, RatingStore, TranslationStore, PracticeStore {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  async dailyChunkCap(): Promise<number> {
    const row = await this.db
      .prepare("SELECT daily_chunk_cap AS cap FROM settings WHERE id = 1")
      .first<{ cap: number }>();
    if (!row) throw new Error("The settings row is missing; apply the migrations");
    return row.cap;
  }

  async chunksAddedToday(): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks c
         JOIN articles a ON a.id = c.article_id
         WHERE date(a.fetched_at) = date('now')`,
      )
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async hasUrl(url: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 AS found FROM articles WHERE url = ?").bind(url).first();
    return row !== null;
  }

  async hasContentHash(hash: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM articles WHERE content_hash = ?")
      .bind(hash)
      .first();
    return row !== null;
  }

  async unratedChunks(limit: number): Promise<UnratedChunk[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, italian_text AS italianText FROM chunks WHERE cefr_probs_json IS NULL ORDER BY id LIMIT ?",
      )
      .bind(limit)
      .all<UnratedChunk>();
    return results;
  }

  async saveRating(chunkId: number, distribution: Distribution, summary: RatingSummary): Promise<void> {
    await this.db
      .prepare(
        `UPDATE chunks
         SET cefr_probs_json = ?, cefr_expected = ?, cefr_top = ?, cefr_confidence = ?
         WHERE id = ?`,
      )
      .bind(JSON.stringify(distribution), summary.expected, summary.top, summary.confidence, chunkId)
      .run();
  }

  async settings(): Promise<Settings> {
    const row = await this.db
      .prepare(
        "SELECT target_level AS targetLevel, level_range AS levelRange, daily_chunk_cap AS dailyChunkCap FROM settings WHERE id = 1",
      )
      .first<Settings>();
    if (!row) throw new Error("The settings row is missing; apply the migrations");
    return row;
  }

  async updateSettings(changes: Partial<Settings>): Promise<Settings> {
    // Column names come from this fixed map, never from the caller, so the SQL stays parameterised.
    const columns = { targetLevel: "target_level", levelRange: "level_range", dailyChunkCap: "daily_chunk_cap" } as const;
    const entries = (Object.keys(columns) as (keyof typeof columns)[]).filter((key) => changes[key] !== undefined);
    if (entries.length > 0) {
      await this.db
        .prepare(`UPDATE settings SET ${entries.map((key) => `${columns[key]} = ?`).join(", ")} WHERE id = 1`)
        .bind(...entries.map((key) => changes[key]))
        .run();
    }
    return this.settings();
  }

  async attemptToExplain(id: number): Promise<AttemptForExplanation | null> {
    return this.db
      .prepare(
        `SELECT t.id, c.italian_text AS italian, c.reference_en AS reference, t.attempt_text AS attemptText,
                t.verdict_top AS verdictTop, e.text AS explanation
         FROM attempts t
         JOIN chunks c ON c.id = t.chunk_id
         LEFT JOIN explanations e ON e.attempt_id = t.id
         WHERE t.id = ?`,
      )
      .bind(id)
      .first<AttemptForExplanation>();
  }

  async saveExplanation(attemptId: number, text: string, model: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO explanations (attempt_id, text, model) VALUES (?, ?, ?)")
      .bind(attemptId, text, model)
      .run();
  }

  async recentAttempts(limit: number): Promise<HistoryEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.created_at AS createdAt, c.italian_text AS italian, t.attempt_text AS attempt,
                t.verdict_top AS verdictTop, t.confidence, t.fluency_score AS fluencyScore,
                t.needs_explanation AS needsExplanation, c.reference_en AS reference, e.text AS explanation
         FROM attempts t
         JOIN chunks c ON c.id = t.chunk_id
         LEFT JOIN explanations e ON e.attempt_id = t.id
         ORDER BY t.id DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<Omit<HistoryEntry, "needsExplanation" | "createdAt"> & { needsExplanation: number; createdAt: string }>();
    return results.map((row) => ({
      ...row,
      // SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC.
      createdAt: `${row.createdAt.replace(" ", "T")}Z`,
      needsExplanation: row.needsExplanation === 1,
    }));
  }

  async nextChunk(levels: string[]): Promise<PracticeChunk | null> {
    const placeholders = levels.map(() => "?").join(", ");
    const row = await this.db
      .prepare(
        `SELECT c.id, c.italian_text AS italian, c.cefr_probs_json AS probs, a.title, a.url
         FROM chunks c JOIN articles a ON a.id = c.article_id
         WHERE c.reference_en IS NOT NULL AND c.cefr_top IN (${placeholders})
         ORDER BY (SELECT COUNT(*) FROM attempts t WHERE t.chunk_id = c.id), RANDOM()
         LIMIT 1`,
      )
      .bind(...levels)
      .first<{ id: number; italian: string; probs: string; title: string; url: string }>();
    if (!row) return null;
    return {
      id: row.id,
      italian: row.italian,
      source: { title: row.title, url: row.url },
      cefrDistribution: JSON.parse(row.probs) as Distribution,
    };
  }

  async chunkToMark(id: number): Promise<{ id: number; italian: string; reference: string } | null> {
    return this.db
      .prepare(
        "SELECT id, italian_text AS italian, reference_en AS reference FROM chunks WHERE id = ? AND reference_en IS NOT NULL",
      )
      .bind(id)
      .first();
  }

  async saveAttempt(attempt: NewAttempt): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO attempts
           (chunk_id, attempt_text, verdict_probs_json, verdict_top, fluency_score, confidence, needs_explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        attempt.chunkId,
        attempt.attemptText,
        JSON.stringify(attempt.verdict),
        attempt.verdictTop,
        attempt.fluencyScore,
        attempt.confidence,
        attempt.needsExplanation ? 1 : 0,
      )
      .first<{ id: number }>();
    if (!row) throw new Error("The attempt was not saved");
    return row.id;
  }

  async recordCall(purpose: string, call: CallRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO ai_calls (purpose, model, ok, duration_ms, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(purpose, call.model, call.ok ? 1 : 0, Math.round(call.durationMs), call.inputTokens, call.outputTokens)
      .run();
  }

  async logRequest(route: string): Promise<void> {
    await this.db.prepare("INSERT INTO request_log (route) VALUES (?)").bind(route).run();
  }

  async requestsInLastSeconds(route: string, seconds: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM request_log WHERE route = ? AND at >= datetime('now', ?)")
      .bind(route, `-${Math.floor(seconds)} seconds`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Counts the current UTC day, which is also when the daily limits reset. */
  async requestsToday(route: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM request_log WHERE route = ? AND date(at) = date('now')")
      .bind(route)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async usageCalls(days: number): Promise<CallRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT purpose, model, ok, duration_ms AS durationMs, input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM ai_calls WHERE at >= datetime('now', ?) ORDER BY id DESC LIMIT 5000`,
      )
      .bind(`-${Math.floor(days)} days`)
      .all<Omit<CallRow, "ok"> & { ok: number }>();
    return results.map((row) => ({ ...row, ok: row.ok === 1 }));
  }

  /** Keeps the log tables small. The limits only look back one day. */
  async pruneOldRows(): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM request_log WHERE at < datetime('now', '-2 days')"),
      this.db.prepare("DELETE FROM ai_calls WHERE at < datetime('now', '-90 days')"),
    ]);
  }

  async untranslatedChunks(limit: number): Promise<UntranslatedChunk[]> {
    const { results } = await this.db
      .prepare(
        "SELECT id, italian_text AS italianText FROM chunks WHERE reference_en IS NULL ORDER BY id LIMIT ?",
      )
      .bind(limit)
      .all<UntranslatedChunk>();
    return results;
  }

  async saveTranslation(chunkId: number, english: string): Promise<void> {
    await this.db
      .prepare("UPDATE chunks SET reference_en = ?, translated_at = datetime('now') WHERE id = ?")
      .bind(english, chunkId)
      .run();
  }

  /** One batch, so an article never exists without its chunks. */
  async saveArticle(article: StoredArticle, chunks: Chunk[]): Promise<void> {
    const statements = [
      this.db
        .prepare("INSERT INTO articles (url, title, published_at, content_hash) VALUES (?, ?, ?, ?)")
        .bind(article.url, article.title, article.publishedAt, article.contentHash),
      ...chunks.map((chunk) =>
        this.db
          .prepare(
            `INSERT INTO chunks (article_id, position, italian_text, word_count, heuristics_json)
             VALUES ((SELECT id FROM articles WHERE url = ?), ?, ?, ?, ?)`,
          )
          .bind(article.url, chunk.position, chunk.text, chunk.wordCount, JSON.stringify(chunk.heuristics)),
      ),
    ];
    await this.db.batch(statements);
  }
}
