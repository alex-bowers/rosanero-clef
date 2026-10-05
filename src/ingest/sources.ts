import { decodeEntities } from "./html.ts";

const SITE = "https://forzapalermo.it/";

/** Article URLs from an HTML listing page, newest first. Articles are root-level slugs. */
export function parseListing(html: string): string[] {
  const urls = [...html.matchAll(/<h3 class="title">\s*<a href="([^"]+)"/g)].map((m) =>
    decodeEntities(m[1]),
  );
  return unique(urls.filter(isArticleUrl));
}

/** Article URLs from an RSS feed. Item bodies are ignored: text always comes from the page. */
export function parseRss(xml: string): string[] {
  const urls = [...xml.matchAll(/<item>[\s\S]*?<link>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/g)].map(
    (m) => decodeEntities(m[1]),
  );
  return unique(urls.filter(isArticleUrl));
}

function isArticleUrl(url: string): boolean {
  if (!url.startsWith(SITE)) return false;
  const path = url.slice(SITE.length);
  // "-live" posts are one-paragraph promotions for a video stream (checked 3 October 2026).
  return /^[a-z0-9-]+$/i.test(path) && !path.endsWith("-forzapalermoit-live");
}

function unique(urls: string[]): string[] {
  return [...new Set(urls)];
}
