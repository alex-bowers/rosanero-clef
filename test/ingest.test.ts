import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractArticle } from "../src/ingest/html.ts";
import { parseListing, parseRss } from "../src/ingest/sources.ts";
import { PoliteFetcher, USER_AGENT } from "../src/ingest/fetch.ts";
import { discoverArticleUrls, FEED_URL, LISTING_URLS } from "../src/ingest/discover.ts";
import { chunkParagraphs } from "../src/ingest/chunk.ts";
import { ARTICLE_HTML, LISTING_HTML, RSS_XML } from "./fixtures/site-pages.ts";

test("decodes named, numeric and hex entities, case-sensitively", () => {
  assert.equal(decodeEntities("&Egrave; &egrave; &#232; &#xE8; &amp;"), "È è è è &");
  assert.equal(decodeEntities("&unknown; &#0;"), "&unknown; &#0;");
});

test("extracts title, date and paragraphs, and stops before tags and comments", () => {
  const article = extractArticle(ARTICLE_HTML);
  assert.ok(article);
  assert.equal(article.title, "Il Palermo vince in casa: è una serata speciale");
  assert.equal(article.publishedAt, "2026-09-29 16:57:02");
  assert.equal(article.paragraphs.length, 3);
  assert.match(article.paragraphs[0], /^Il Palermo ha vinto al Barbera\. La partita è stata/);
  assert.ok(!article.paragraphs.join(" ").includes("commento"));
  assert.ok(!article.paragraphs.join(" ").includes("Tag:"));
});

test("returns null for a page with no article body (soft 404)", () => {
  assert.equal(extractArticle("<html><title>404 Page Not Found</title></html>"), null);
});

test("listing keeps unique on-site article slugs, without profiles, external links or -live promos", () => {
  assert.deepEqual(parseListing(LISTING_HTML), [
    "https://forzapalermo.it/prima-notizia",
    "https://forzapalermo.it/seconda-notizia",
  ]);
});

test("RSS reads plain and CDATA links, skipping the channel link", () => {
  assert.deepEqual(parseRss(RSS_XML), [
    "https://forzapalermo.it/prima-notizia",
    "https://forzapalermo.it/seconda-notizia",
  ]);
});

test("PoliteFetcher sends the User-Agent, spaces requests and rejects HTTP errors", async () => {
  const seen: { url: string; at: number; agent: string | null }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, at: Date.now(), agent: new Headers(init?.headers).get("user-agent") });
    return new Response(url.endsWith("bad") ? "no" : "ok", { status: url.endsWith("bad") ? 500 : 200 });
  }) as unknown as typeof fetch;
  const fetcher = new PoliteFetcher({ delayMs: 60, fetchFn });

  assert.equal(await fetcher.get("https://x.test/a"), "ok");
  await fetcher.get("https://x.test/b");
  await assert.rejects(fetcher.get("https://x.test/bad"), /HTTP 500/);

  assert.equal(seen[0].agent, USER_AGENT);
  assert.ok(seen[1].at - seen[0].at >= 55, "second request waited for the delay");
  assert.ok(seen[2].at - seen[1].at >= 55);
});

test("discovery uses the feed when it works", async () => {
  const fetcher = { get: async () => RSS_XML };
  const result = await discoverArticleUrls(fetcher, 10);
  assert.equal(result.source, "feed");
  assert.equal(result.urls.length, 2);
});

test("discovery falls back to listings when the feed returns HTTP 500", async () => {
  const requested: string[] = [];
  const fetcher = {
    get: async (url: string) => {
      requested.push(url);
      if (url === FEED_URL) throw new Error("GET failed with HTTP 500");
      return LISTING_HTML;
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await discoverArticleUrls(fetcher, 10);
    assert.equal(result.source, "listing");
    assert.equal(result.urls.length, 2);
    assert.deepEqual(requested, [FEED_URL, LISTING_URLS[0], LISTING_URLS[1]]);
  } finally {
    console.warn = warn;
  }
});

test("discovery respects the limit and skips a failing listing", async () => {
  const fetcher = {
    get: async (url: string) => {
      if (url === LISTING_URLS[0]) throw new Error("boom");
      if (url === FEED_URL) throw new Error("boom");
      return LISTING_HTML;
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await discoverArticleUrls(fetcher, 1);
    assert.equal(result.urls.length, 1);
  } finally {
    console.warn = warn;
  }
});

test("chunks group 1 to 3 sentences, reaching 15 words, and carry heuristics", () => {
  const paragraph =
    "Il Palermo ha vinto in casa contro la squadra ospite. La partita è stata decisa nel secondo tempo da un colpo di testa. I tifosi hanno riempito lo stadio fin dal primo minuto e hanno cantato per tutta la serata.";
  const chunks = chunkParagraphs([paragraph]);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.position), [0, 1]);
  assert.equal(chunks[0].heuristics.sentenceCount, 2);
  assert.equal(chunks[0].wordCount, 23);
  assert.ok(chunks[0].heuristics.meanWordLength > 2);
});

test("chunks drop short tails, full quotes, name lists and boilerplate", () => {
  assert.equal(chunkParagraphs(["Foto: archivio."]).length, 0, "too short");
  assert.equal(
    chunkParagraphs(["«Siamo molto contenti del risultato e della prestazione di tutta la squadra oggi pomeriggio.»"]).length,
    0,
    "entirely a quote",
  );
  assert.equal(
    chunkParagraphs(["Formazione: Joronen, Diakité, Bani, Ceccaroni, Augello, Segre, Ranocchia, Brunori, Pohjanpalo, Le Douaron, Gyasi."]).length,
    0,
    "name list",
  );
  assert.equal(
    chunkParagraphs(["Leggi anche: tutte le notizie sul Palermo e sulla squadra di oggi, e molto altro ancora per te."]).length,
    0,
    "boilerplate",
  );
});

test("a very long sentence is kept as its own chunk, not merged past 60 words", () => {
  const long = Array.from({ length: 70 }, () => "parola").join(" ") + ".";
  const chunks = chunkParagraphs([long + " Una frase breve ma abbastanza lunga da poter essere usata come esempio di studio."]);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].wordCount, 70);
});
