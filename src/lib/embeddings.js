import crypto from 'node:crypto';
import { config } from '../config.js';
import { estimateTokens } from './utils.js';

const pseudoEmbedding = (text, dim) => {
  const seed = crypto.createHash('sha256').update(text || '', 'utf8').digest();
  const out = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    const byte = seed[i % seed.length];
    out[i] = (byte / 127.5) - 1;
  }
  return out;
};

const buildEmbeddingBatches = (texts, maxTokens) => {
  if (!texts.length) return [];
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (current.length && currentTokens + tokens > maxTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length) batches.push(current);
  return batches;
};

const isContextLengthError = (error) => {
  const message = error?.message || '';
  return message.includes('maximum context length')
    || message.includes('context_length_exceeded')
    || message.includes('context length');
};

const trimToTokenEstimate = (text, maxTokens) => {
  if (!text) return text;
  const estimate = estimateTokens(text);
  if (estimate <= maxTokens) return text;
  const ratio = maxTokens / estimate;
  let end = Math.max(50, Math.floor(text.length * ratio));
  let trimmed = text.slice(0, end);
  let attempts = 0;
  while (estimateTokens(trimmed) > maxTokens && attempts < 6 && end > 50) {
    end = Math.floor(end * 0.8);
    trimmed = text.slice(0, end);
    attempts += 1;
  }
  if (trimmed.length > maxTokens) {
    trimmed = trimmed.slice(0, maxTokens);
  }
  return trimmed;
};

const embedBatchOpenAI = async (texts) => {
  // No logging of raw text; only counts to avoid sensitive data in logs.
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => null);
    throw new Error(`OpenAI embeddings failed: ${response.status} ${text || response.statusText}`);
  }
  const data = await response.json();
  return data.data.map(item => item.embedding);
};

export const embedTexts = async (texts) => {
  if (!texts.length) return [];
  if (config.embeddingProvider !== 'openai' || !config.openaiApiKey) {
    return texts.map(text => pseudoEmbedding(text, config.embeddingDim));
  }
  const maxTokens = Math.max(1, config.embeddingMaxTokens || 8000);
  const batches = buildEmbeddingBatches(texts, maxTokens);
  const embeddings = [];
  for (const batch of batches) {
    try {
      const batchEmbeddings = await embedBatchOpenAI(batch);
      embeddings.push(...batchEmbeddings);
    } catch (error) {
      if (isContextLengthError(error)) {
        if (batch.length > 1) {
          for (const text of batch) {
            try {
              const singleEmbedding = await embedBatchOpenAI([text]);
              embeddings.push(...singleEmbedding);
            } catch (singleError) {
              if (isContextLengthError(singleError)) {
                const trimmed = trimToTokenEstimate(text, maxTokens);
                const singleEmbedding = await embedBatchOpenAI([trimmed]);
                embeddings.push(...singleEmbedding);
              } else {
                throw singleError;
              }
            }
          }
        } else {
          const trimmed = trimToTokenEstimate(batch[0], maxTokens);
          const singleEmbedding = await embedBatchOpenAI([trimmed]);
          embeddings.push(...singleEmbedding);
        }
      } else {
        throw error;
      }
    }
  }
  return embeddings;
};

export const embedText = async (text) => {
  const [embedding] = await embedTexts([text]);
  return embedding;
};
