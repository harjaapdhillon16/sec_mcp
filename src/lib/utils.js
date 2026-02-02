import crypto from 'node:crypto';

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const sha256 = (text) => {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
};

export const cleanText = (text) => {
  if (!text) return '';
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
};

export const normalizeTicker = (ticker) => {
  return ticker ? String(ticker).trim().toUpperCase() : null;
};

export const normalizeCik = (value) => {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(10, '0');
};

export const splitSentences = (text) => {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map(s => s.trim())
    .filter(s => s.length > 20);
};

export const tokenizeWords = (text) => {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
};

export const estimateTokens = (text) => {
  if (!text) return 0;
  const wordCount = tokenizeWords(text).length;
  const wordEstimate = Math.ceil(wordCount * 1.3);
  const charEstimate = Math.ceil(text.length / 3);
  return Math.max(wordEstimate, charEstimate);
};

export const clamp = (value, min, max) => {
  return Math.min(Math.max(value, min), max);
};

export const percentChange = (current, previous) => {
  if (previous === 0 || previous === null || previous === undefined) return null;
  return (current - previous) / Math.abs(previous);
};
