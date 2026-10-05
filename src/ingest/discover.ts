import type { PageFetcher } from "./fetch.ts";
import { parseListing, parseRss } from "./sources.ts";

export const FEED_URL = "https://forzapalermo.it/rss/latest-posts";
export const LISTING_URLS = [
  "https://forzapalermo.it/forzapalermo-news",
  "https://forzapalermo.it/articoli",
];

export interface Discovery {
  urls: string[];
  source: "feed" | "listing";
}

/**
 * Prefers the RSS feed. On 3 October 2026 the feeds returned HTTP 500, so listing pages
 * are the fallback when the feed fails or is empty.
 */
export async function discoverArticleUrls(
  fetcher: PageFetcher,
  limit: number,
): Promise<Discovery> {
  try {
    const urls = parseRss(await fetcher.get(FEED_URL));
    if (urls.length > 0) return { urls: urls.slice(0, limit), source: "feed" };
    console.warn("Feed had no articles; falling back to listing pages");
  } catch (error) {
    console.warn(`Feed failed; falling back to listing pages: ${String(error)}`);
  }

  const urls = new Set<string>();
  for (const listingUrl of LISTING_URLS) {
    if (urls.size >= limit) break;
    try {
      for (const url of parseListing(await fetcher.get(listingUrl))) urls.add(url);
    } catch (error) {
      console.warn(`Listing ${listingUrl} failed: ${String(error)}`);
    }
  }
  return { urls: [...urls].slice(0, limit), source: "listing" };
}
