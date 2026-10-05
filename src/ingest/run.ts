import type { Chunk } from "./chunk.ts";
import { chunkParagraphs } from "./chunk.ts";
import { discoverArticleUrls } from "./discover.ts";
import type { PageFetcher } from "./fetch.ts";
import { extractArticle } from "./html.ts";

/** Most articles inspected per run, which bounds the requests made at one every 3 seconds. */
const MAX_ARTICLES_PER_RUN = 15;

export interface StoredArticle {
  url: string;
  title: string;
  publishedAt: string | null;
  contentHash: string;
}

export interface IngestStore {
  dailyChunkCap(): Promise<number>;
  chunksAddedToday(): Promise<number>;
  hasUrl(url: string): Promise<boolean>;
  hasContentHash(hash: string): Promise<boolean>;
  saveArticle(article: StoredArticle, chunks: Chunk[]): Promise<void>;
}

export interface IngestSummary {
  source: "feed" | "listing";
  articlesAdded: number;
  chunksAdded: number;
  skipped: number;
  failed: number;
}

/**
 * The cap is soft: it is checked between articles and an article is always stored whole,
 * because truncating it would lose the rest for good once its URL counts as seen.
 */
export async function runIngest(deps: {
  store: IngestStore;
  fetcher: PageFetcher;
}): Promise<IngestSummary> {
  const { store, fetcher } = deps;
  let remaining = (await store.dailyChunkCap()) - (await store.chunksAddedToday());
  const summary: IngestSummary = { source: "feed", articlesAdded: 0, chunksAdded: 0, skipped: 0, failed: 0 };
  if (remaining <= 0) return summary;

  const discovery = await discoverArticleUrls(fetcher, MAX_ARTICLES_PER_RUN);
  summary.source = discovery.source;

  for (const url of discovery.urls) {
    if (remaining <= 0) break;
    if (await store.hasUrl(url)) {
      summary.skipped++;
      continue;
    }

    try {
      const article = extractArticle(await fetcher.get(url));
      if (!article) {
        summary.skipped++;
        continue;
      }
      const contentHash = await sha256(article.paragraphs.join("\n"));
      if (await store.hasContentHash(contentHash)) {
        summary.skipped++;
        continue;
      }

      // Stored even with no usable chunks, so the page is not fetched again tomorrow.
      const chunks = chunkParagraphs(article.paragraphs);
      await store.saveArticle(
        { url, title: article.title, publishedAt: article.publishedAt, contentHash },
        chunks,
      );
      summary.articlesAdded++;
      summary.chunksAdded += chunks.length;
      remaining -= chunks.length;
    } catch (error) {
      console.warn(`Ingest failed for ${url}: ${String(error)}`);
      summary.failed++;
    }
  }
  return summary;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
