import { NEGATIVE_TERMS } from './constants.js';
import { splitSentences, tokenizeWords } from './utils.js';

const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
};

const sentenceSimilarity = (a, b) => {
  return jaccard(tokenizeWords(a), tokenizeWords(b));
};

const topByScore = (items, limit) => {
  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.text);
};

export const compareSections = (currentText, previousText) => {
  const currentSentences = splitSentences(currentText);
  const previousSentences = splitSentences(previousText);
  const newItems = [];
  const removedItems = [];
  const intensifiedCandidates = [];

  for (const sentence of currentSentences) {
    const maxSim = previousSentences.reduce((max, prev) => {
      const sim = sentenceSimilarity(sentence, prev);
      return sim > max ? sim : max;
    }, 0);
    if (maxSim < 0.25) {
      newItems.push(sentence);
    }
    const words = tokenizeWords(sentence);
    const neg = words.filter(w => NEGATIVE_TERMS.includes(w)).length;
    intensifiedCandidates.push({ text: sentence, score: neg });
  }

  for (const sentence of previousSentences) {
    const maxSim = currentSentences.reduce((max, cur) => {
      const sim = sentenceSimilarity(sentence, cur);
      return sim > max ? sim : max;
    }, 0);
    if (maxSim < 0.25) {
      removedItems.push(sentence);
    }
  }

  return {
    newItems: newItems.slice(0, 5),
    removedItems: removedItems.slice(0, 5),
    intensifiedItems: topByScore(intensifiedCandidates, 5)
  };
};
