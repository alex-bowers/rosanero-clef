const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»",
  hellip: "…", ndash: "–", mdash: "—", euro: "€",
  agrave: "à", egrave: "è", eacute: "é", igrave: "ì", ograve: "ò", ugrave: "ù",
  Agrave: "À", Egrave: "È", Eacute: "É", Igrave: "Ì", Ograve: "Ò", Ugrave: "Ù",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExtractedArticle {
  title: string;
  publishedAt: string | null;
  paragraphs: string[];
}

/** Returns null when the page has no article body, for example a soft 404. */
export function extractArticle(html: string): ExtractedArticle | null {
  const bodyMarker = html.indexOf('class="post-text"');
  if (bodyMarker === -1) return null;

  const start = html.indexOf(">", bodyMarker) + 1;
  // The site has no closing marker for the body, so stop at whatever follows it.
  const ends = ['class="post-tags"', 'class="comment-section"']
    .map((marker) => html.indexOf(marker, start))
    .filter((index) => index !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : html.indexOf("</div>", start);
  const region = html.slice(start, end === -1 ? undefined : end);

  const paragraphs = [...region.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((paragraph) => paragraph.length > 0);

  const title =
    metaContent(html, "og:title") ??
    stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (title === "" || paragraphs.length === 0) return null;

  return { title, publishedAt: metaContent(html, "article:published_time"), paragraphs };
}

function metaContent(html: string, property: string): string | null {
  const match = html.match(
    new RegExp(`<meta\\s+property="${property}"\\s+content="([^"]*)"`, "i"),
  );
  return match ? decodeEntities(match[1]).trim() : null;
}
