import { processEach } from "./pending.ts";
import type { LlmClient } from "./types.ts";

export interface UntranslatedChunk {
  id: number;
  italianText: string;
}

export interface TranslationStore {
  untranslatedChunks(limit: number): Promise<UntranslatedChunk[]>;
  saveTranslation(chunkId: number, english: string): Promise<void>;
}

export interface TranslationRunSummary {
  translated: number;
  failed: number;
  stoppedEarly: boolean;
}

/** Writes the stored reference translation once per chunk; the LLM is not used again for it. */
export async function runTranslation(deps: {
  store: TranslationStore;
  llm: LlmClient;
  limit?: number;
}): Promise<TranslationRunSummary> {
  const { store, llm } = deps;
  const run = await processEach(
    await store.untranslatedChunks(deps.limit ?? 100),
    async (chunk) => {
      // One chunk per call, so a bad reply cannot misalign the others.
      const [english] = await llm.translate([chunk.italianText]);
      if (!english?.trim()) throw new Error("Empty translation");
      await store.saveTranslation(chunk.id, english.trim());
    },
    (chunk) => `Translating chunk ${chunk.id}`,
  );
  return { translated: run.done, failed: run.failed, stoppedEarly: run.stoppedEarly };
}
