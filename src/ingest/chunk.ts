export interface Heuristics {
  wordCount: number;
  sentenceCount: number;
  meanSentenceLength: number;
  meanWordLength: number;
}

export interface Chunk {
  position: number;
  text: string;
  wordCount: number;
  heuristics: Heuristics;
}

const MIN_WORDS = 15;
const MAX_WORDS = 60;
const MAX_SENTENCES = 3;
/** A shorter leftover at the end of a paragraph is too thin to practise on. */
const MIN_TAIL_WORDS = 8;

const BOILERPLATE =
  /\b(leggi anche|segui|iscriviti|clicca|foto:|ph:|tutti i diritti riservati|newsletter)\b|©/i;

const segmenter = new Intl.Segmenter("it", { granularity: "sentence" });

export function chunkParagraphs(paragraphs: string[]): Chunk[] {
  const chunks: Chunk[] = [];

  for (const paragraph of paragraphs) {
    for (const sentences of groupSentences(splitSentences(paragraph))) {
      const text = sentences.join(" ");
      if (!isUsable(text)) continue;
      chunks.push({
        position: chunks.length,
        text,
        wordCount: words(text).length,
        heuristics: heuristics(sentences),
      });
    }
  }
  return chunks;
}

export function splitSentences(paragraph: string): string[] {
  return [...segmenter.segment(paragraph)].map((s) => s.segment.trim()).filter(Boolean);
}

/** Groups consecutive sentences into runs of 1 to 3, aiming for 15 to 60 words. */
function groupSentences(sentences: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    currentWords = 0;
  };

  for (const sentence of sentences) {
    const count = words(sentence).length;
    if (current.length > 0 && (current.length >= MAX_SENTENCES || currentWords + count > MAX_WORDS)) {
      flush();
    }
    current.push(sentence);
    currentWords += count;
    if (currentWords >= MIN_WORDS) flush();
  }

  if (currentWords >= MIN_TAIL_WORDS) flush();
  return groups;
}

function isUsable(text: string): boolean {
  if (BOILERPLATE.test(text)) return false;
  // A chunk that is entirely a quotation has no context to learn from.
  if (/^[«"“].*[»"”]$/s.test(text)) return false;

  const tokens = words(text);
  const capitalised = tokens.slice(1).filter((token) => /^\p{Lu}/u.test(token)).length;
  // Mostly capitalised words suggests a list of names, such as a line-up.
  return !(tokens.length >= 6 && capitalised / (tokens.length - 1) >= 0.5);
}

function heuristics(sentences: string[]): Heuristics {
  const tokens = words(sentences.join(" "));
  const letters = tokens.reduce((sum, token) => sum + token.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  return {
    wordCount: tokens.length,
    sentenceCount: sentences.length,
    meanSentenceLength: round(tokens.length / sentences.length),
    meanWordLength: round(letters / tokens.length),
  };
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
