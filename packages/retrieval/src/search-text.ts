const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const cjkRuns = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const segmenter = new Intl.Segmenter("zh", {
  granularity: "word",
});

/** Prefer words and exact code identifiers before full CJK runs or cross-word bigrams. */
export const retrievalWordTokens = (input: string): readonly string[] => {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("en-US");
  const literals = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (!cjk.test(normalized)) return [...new Set(literals)];
  const words: string[] = [];
  let previous: { text: string; end: number } | undefined;
  for (const segment of segmenter.segment(normalized)) {
    const text = segment.segment;
    if (!segment.isWordLike) { previous = undefined; continue; }
    // ICU can return unknown two-character words as adjacent single Han characters.
    // Join only those adjacent fragments, not every pair across recognized words.
    if (cjk.test(text) && [...text].length === 1) {
      if (previous?.end === segment.index) words.push(previous.text + text);
      previous = { text, end: segment.index + text.length };
    } else {
      words.push(text);
      previous = undefined;
    }
  }
  return [...new Set([...literals.filter((token) => !cjk.test(token)), ...words])];
};

export const retrievalTokens = (input: string): readonly string[] => {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const result = new Set<string>(tokens);
  if (cjk.test(normalized)) {
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike) {
        result.add(segment.segment);
      }
    }
    for (const run of normalized.match(cjkRuns) ?? []) {
      const characters = [...run];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(characters.slice(index, index + 2).join(""));
      }
    }
  }
  return [...result];
};

export const searchableText = (input: string): string =>
  [
    input,
    ...retrievalTokens(input).filter((token) => cjk.test(token)),
  ].join("\n");
