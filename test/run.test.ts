import { test } from "node:test";
import assert from "node:assert/strict";
import { D1Store } from "../src/db.ts";
import { runIngest } from "../src/ingest/run.ts";
import { parseListing } from "../src/ingest/sources.ts";
import { FEED_URL, LISTING_URLS } from "../src/ingest/discover.ts";
import { createTestDb } from "./helpers/sqlite-d1.ts";
import { LISTING_HTML } from "./fixtures/site-pages.ts";

const PARAGRAPH =
  "Il Palermo ha vinto in casa contro la squadra ospite. La partita è stata decisa nel secondo tempo da un colpo di testa. I tifosi hanno riempito lo stadio fin dal primo minuto e hanno cantato per tutta la serata.";

function page(title: string, paragraphs: string[]): string {
  return `<meta property="og:title" content="${title}"/>
<div class="post-text">${paragraphs.map((p) => `<p>${p}</p>`).join("")}</div><div class="post-tags"></div>`;
}

/** Serves the listing for discovery (feed fails) and generated pages for each article URL. */
function fakeSite(pages: Record<string, string>) {
  const requested: string[] = [];
  return {
    requested,
    fetcher: {
      get: async (url: string) => {
        requested.push(url);
        if (url === FEED_URL) throw new Error("HTTP 500");
        if (url === LISTING_URLS[0]) return LISTING_HTML;
        if (url === LISTING_URLS[1]) return "";
        if (url in pages) return pages[url];
        throw new Error(`HTTP 404 for ${url}`);
      },
    },
  };
}

const [FIRST, SECOND] = parseListing(LISTING_HTML);

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test("stores articles with their chunks, and a second run adds nothing", async () => {
  const db = createTestDb();
  const site = fakeSite({ [FIRST]: page("Uno", [PARAGRAPH]), [SECOND]: page("Due", [PARAGRAPH]) });
  const store = new D1Store(db);

  const first = await quietly(() => runIngest({ store, fetcher: site.fetcher }));
  assert.equal(first.source, "listing");
  assert.equal(first.articlesAdded, 1, "identical body text is deduplicated by content hash");
  assert.equal(first.skipped, 1);
  assert.equal(first.chunksAdded, 2);

  const chunks = await db.prepare("SELECT position, italian_text, heuristics_json FROM chunks ORDER BY position").all<{ position: number; heuristics_json: string }>();
  assert.equal(chunks.results.length, 2);
  assert.equal(JSON.parse(chunks.results[0].heuristics_json).sentenceCount, 2);

  const second = await quietly(() => runIngest({ store, fetcher: site.fetcher }));
  assert.equal(second.articlesAdded, 0);
  assert.equal(second.skipped, 2, "one known URL, and one page whose text is already stored");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM articles").first<{ n: number }>())?.n, 1);
});

test("stops once the daily cap is reached", async () => {
  const db = createTestDb();
  db.raw.exec("UPDATE settings SET daily_chunk_cap = 2");
  const site = fakeSite({ [FIRST]: page("Uno", [PARAGRAPH]), [SECOND]: page("Due", ["Una frase del tutto diversa, scritta apposta per avere un testo diverso dal primo articolo di prova."]) });

  const summary = await quietly(() => runIngest({ store: new D1Store(db), fetcher: site.fetcher }));
  assert.equal(summary.articlesAdded, 1);
  assert.equal(summary.chunksAdded, 2);
  assert.ok(!site.requested.includes(SECOND), "no request is spent on the second article");
});

test("a failing article is counted and does not stop the run", async () => {
  const db = createTestDb();
  const site = fakeSite({ [SECOND]: page("Due", [PARAGRAPH]) }); // FIRST returns an error
  const summary = await quietly(() => runIngest({ store: new D1Store(db), fetcher: site.fetcher }));
  assert.equal(summary.failed, 1);
  assert.equal(summary.articlesAdded, 1);
});

test("a page with no usable chunks is recorded so it is not fetched again", async () => {
  const db = createTestDb();
  const site = fakeSite({ [FIRST]: page("Uno", ["Foto: archivio."]), [SECOND]: page("Due", ["Foto: altro."]) });
  const store = new D1Store(db);

  await quietly(() => runIngest({ store, fetcher: site.fetcher }));
  assert.equal(await store.hasUrl(FIRST), true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM chunks").first<{ n: number }>())?.n, 0);
});

test("a failed batch leaves no half-saved article", async () => {
  const db = createTestDb();
  const store = new D1Store(db);
  const article = { url: "https://forzapalermo.it/x", title: "X", publishedAt: null, contentHash: "h" };
  const chunk = { position: 0, text: "t", wordCount: 1, heuristics: { wordCount: 1, sentenceCount: 1, meanSentenceLength: 1, meanWordLength: 1 } };

  await assert.rejects(store.saveArticle(article, [chunk, chunk]), /UNIQUE|constraint/i);
  assert.equal(await store.hasUrl(article.url), false);
});
