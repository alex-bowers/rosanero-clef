import type { DecisionClient, Distribution } from "../types.ts";

/** Puts `topShare` on the option at `topIndex` and splits the rest evenly. */
function weighted(labels: string[], topIndex: number, topShare: number): Distribution {
  const rest = labels.length > 1 ? (1 - topShare) / (labels.length - 1) : 0;
  return labels.map((label, i) => ({
    label,
    probability: labels.length === 1 ? 1 : i === topIndex ? topShare : rest,
  }));
}

export class MockDecisionClient implements DecisionClient {
  private readonly opts: { topIndex?: number; topShare?: number };

  // Explicit field, not a parameter property: Node's type stripping rejects that syntax.
  constructor(opts: { topIndex?: number; topShare?: number } = {}) {
    this.opts = opts;
  }

  async choice({ options }: { options: string[] }): Promise<Distribution> {
    return weighted(options, this.opts.topIndex ?? 0, this.opts.topShare ?? 0.7);
  }

  async score({ levels }: { levels: number }): Promise<Distribution> {
    const labels = Array.from({ length: levels }, (_, i) => String(i));
    return weighted(labels, this.opts.topIndex ?? levels - 1, this.opts.topShare ?? 0.7);
  }
}
