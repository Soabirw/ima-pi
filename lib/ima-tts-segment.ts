export const MAX_SPEECH_INPUT_CHARACTERS = 3_000;

const WHITESPACE = /\s/;

const normalizeBudget = (maxCharacters: number): number | null => {
  if (
    typeof maxCharacters !== "number"
    || !Number.isFinite(maxCharacters)
    || maxCharacters <= 0
  ) {
    return null;
  }

  const budget = Math.floor(maxCharacters);
  return budget > 0 ? budget : null;
};

const isUsefulBoundary = (
  text: string,
  start: number,
  candidate: number,
  end: number,
): boolean =>
  candidate > start
  && candidate <= end
  && Boolean(text.slice(start, candidate).trim());

const preferredBoundary = (
  text: string,
  start: number,
  end: number,
): number => {
  const paragraphBreak = text.lastIndexOf("\n\n", end - 2);
  const paragraphEnd = paragraphBreak + 2;
  if (paragraphBreak >= start && isUsefulBoundary(text, start, paragraphEnd, end)) {
    return paragraphEnd;
  }

  const lineBreak = text.lastIndexOf("\n", end - 1);
  const lineEnd = lineBreak + 1;
  if (lineBreak >= start && isUsefulBoundary(text, start, lineEnd, end)) {
    return lineEnd;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const candidate = index + 1;
    const character = text[index];
    if (
      ".!?".includes(character)
      && WHITESPACE.test(text[index + 1] ?? "")
      && isUsefulBoundary(text, start, candidate, end)
    ) {
      return candidate;
    }
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const candidate = index + 1;
    if (
      WHITESPACE.test(text[index])
      && isUsefulBoundary(text, start, candidate, end)
    ) {
      return candidate;
    }
  }

  return end;
};

export const segmentSpeechText = (
  text: string,
  maxCharacters: number,
): readonly string[] => {
  const budget = normalizeBudget(maxCharacters);
  if (typeof text !== "string" || !text.trim() || !budget) {
    return Object.freeze([]);
  }
  if (text.length <= budget) return Object.freeze([text]);

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + budget, text.length);
    if (end === text.length) {
      chunks.push(text.slice(start));
      break;
    }

    const chunkEnd = preferredBoundary(text, start, end);
    chunks.push(text.slice(start, chunkEnd));
    start = chunkEnd;
  }

  return Object.freeze(chunks);
};
