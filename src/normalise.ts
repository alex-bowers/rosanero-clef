/**
 * Light tidying of a typed attempt before scoring: single spaces, a capital first letter and a
 * final full stop. It never changes the words, so it cannot change the meaning.
 */
export function tidyAttempt(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed === "") return "";

  const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?…"”)]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
