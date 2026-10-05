import { processEach } from "./pending.ts";
import { CEFR_DESCRIPTIONS, CEFR_INSTRUCTIONS, CEFR_LEVELS, summariseRating } from "./rating.ts";
import type { RatingSummary } from "./rating.ts";
import type { DecisionClient, Distribution } from "./types.ts";

export interface UnratedChunk {
  id: number;
  italianText: string;
}

export interface RatingStore {
  unratedChunks(limit: number): Promise<UnratedChunk[]>;
  saveRating(chunkId: number, distribution: Distribution, summary: RatingSummary): Promise<void>;
}

export interface RatingRunSummary {
  rated: number;
  failed: number;
  stoppedEarly: boolean;
}

/** Rates every chunk that has no rating yet, so a failed run is picked up by the next one. */
export async function runRating(deps: {
  store: RatingStore;
  decision: DecisionClient;
  limit?: number;
}): Promise<RatingRunSummary> {
  const { store, decision } = deps;
  const run = await processEach(
    await store.unratedChunks(deps.limit ?? 100),
    async (chunk) => {
      const distribution = await decision.choice({
        state: chunk.italianText,
        instructions: CEFR_INSTRUCTIONS,
        options: [...CEFR_LEVELS],
        descriptions: CEFR_DESCRIPTIONS,
      });
      await store.saveRating(chunk.id, distribution, summariseRating(distribution));
    },
    (chunk) => `Rating chunk ${chunk.id}`,
  );
  return { rated: run.done, failed: run.failed, stoppedEarly: run.stoppedEarly };
}
