import { NEGATIVE_TERMS, POSITIVE_TERMS } from './constants.js';
import { splitSentences, tokenizeWords } from './utils.js';

const detectTone = (text) => {
  const words = tokenizeWords(text);
  if (!words.length) return 'neutral';
  const neg = words.filter(w => NEGATIVE_TERMS.includes(w)).length;
  const pos = words.filter(w => POSITIVE_TERMS.includes(w)).length;
  if (pos > neg * 1.2) return 'positive';
  if (neg > pos * 1.2) return 'negative';
  return 'neutral';
};

const extractGuidance = (text) => {
  const sentences = splitSentences(text);
  return sentences.filter(s => /guidance|outlook|forecast|expects|expectation/i.test(s)).slice(0, 5);
};

const extractQuotes = (text) => {
  const sentences = splitSentences(text);
  return sentences.filter(s => /we (expect|believe|see|remain)|our (strategy|focus)/i.test(s)).slice(0, 5);
};

export const buildEarningsIntel = (transcriptText) => {
  if (!transcriptText) {
    return {
      summary: null,
      tone: null,
      guidanceChanges: [],
      keyQuotes: []
    };
  }
  const sentences = splitSentences(transcriptText);
  const summary = sentences.slice(0, 3).join(' ');
  return {
    summary: summary || transcriptText.slice(0, 200),
    tone: detectTone(transcriptText),
    guidanceChanges: extractGuidance(transcriptText),
    keyQuotes: extractQuotes(transcriptText)
  };
};
