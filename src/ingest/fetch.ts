/** robots.txt for forzapalermo.it asks for `Crawl-delay: 3` (checked 3 October 2026). */
export const CRAWL_DELAY_MS = 3000;

export const USER_AGENT =
  "PalermoItalianReader/0.1 (private learning project)";

export interface PageFetcher {
  get(url: string): Promise<string>;
}

/** Fetches one page at a time, at least `delayMs` apart. Callers must await each `get`. */
export class PoliteFetcher implements PageFetcher {
  private readonly delayMs: number;
  private readonly fetchFn: typeof fetch;
  private lastRequestAt = 0;

  constructor(options: { delayMs?: number; fetchFn?: typeof fetch } = {}) {
    this.delayMs = options.delayMs ?? CRAWL_DELAY_MS;
    // Wrapped, because calling the global fetch as a method of this class throws "Illegal invocation".
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async get(url: string): Promise<string> {
    const wait = this.lastRequestAt + this.delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();

    const response = await this.fetchFn(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
    return response.text();
  }
}
