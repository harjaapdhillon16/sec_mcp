import { estimateTokens, tokenizeWords } from './utils.js';

export const chunkText = (text, maxWords, overlapWords, maxTokens = null) => {
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const derivedMaxWords = maxTokens ? Math.max(50, Math.floor(maxTokens / 1.3)) : maxWords;
  const safeMaxWords = maxTokens && Number.isFinite(maxWords)
    ? Math.min(maxWords, derivedMaxWords)
    : derivedMaxWords;
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + safeMaxWords, words.length);
    const chunkWords = words.slice(start, end);
    const chunkTextValue = chunkWords.join(' ');
    const tokenCount = tokenizeWords(chunkTextValue).length;
    const tokenEstimate = estimateTokens(chunkTextValue);
    if (maxTokens && tokenEstimate > maxTokens) {
      if (chunkWords.length > 1) {
        const mid = start + Math.max(1, Math.floor(chunkWords.length / 2));
        const reduced = words.slice(start, mid).join(' ');
        chunks.push({ text: reduced, tokenCount: tokenizeWords(reduced).length });
        start = Math.max(start + 1, mid - overlapWords);
        continue;
      }
      const maxChars = Math.max(50, Math.floor(maxTokens * 3));
      const reduced = chunkTextValue.slice(0, maxChars);
      chunks.push({ text: reduced, tokenCount: tokenizeWords(reduced).length });
      if (end >= words.length) break;
      start = Math.max(start + 1, end - overlapWords);
      continue;
    }
    chunks.push({ text: chunkTextValue, tokenCount });
    if (end >= words.length) break;
    start = Math.max(0, end - overlapWords);
  }
  return chunks;
};
