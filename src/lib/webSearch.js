import { config } from '../config.js';
import { htmlToText } from './filingParser.js';
import { cleanText, estimateTokens } from './utils.js';
import { logger } from './logger.js';

const buildTimeoutSignal = (timeoutMs) => {
  if (!timeoutMs) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
};

export const trimToTokens = (text, maxTokens) => {
  if (!text) return '';
  const limit = Math.max(1, Number(maxTokens) || 1);
  if (estimateTokens(text) <= limit) return text;
  const ratio = limit / Math.max(1, estimateTokens(text));
  let end = Math.max(100, Math.floor(text.length * ratio));
  let trimmed = text.slice(0, end);
  let attempts = 0;
  while (estimateTokens(trimmed) > limit && attempts < 6 && end > 100) {
    end = Math.floor(end * 0.8);
    trimmed = text.slice(0, end);
    attempts += 1;
  }
  const hardLimit = Math.max(200, limit * 4);
  if (trimmed.length > hardLimit) {
    trimmed = trimmed.slice(0, hardLimit);
  }
  return trimmed;
};

export const searchWeb = async (query, { maxResults } = {}) => {
  if (!config.tavilyApiKey) {
    return { results: [] };
  }
  const max = Number.isFinite(maxResults) ? maxResults : config.tavilyMaxResults;
  const body = {
    query,
    max_results: Math.min(20, Math.max(1, max || 3)),
    topic: 'general',
    include_raw_content: false,
    include_answer: false,
    include_images: false,
    include_image_descriptions: false,
    search_depth: 'basic'
  };
  const timeout = buildTimeoutSignal(config.tavilyTimeoutMs || 10000);
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.tavilyApiKey}`
      },
      body: JSON.stringify(body),
      signal: timeout?.controller?.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => null);
      throw new Error(`Tavily search failed: ${response.status} ${text || response.statusText}`);
    }
    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map(item => ({
        url: item?.url,
        title: item?.title || '',
        snippet: item?.content || item?.snippet || item?.description || ''
      })).filter(item => item.url)
      : [];
    return { results };
  } catch (error) {
    logger.warn('Tavily search failed', { error: error?.message });
    return { results: [] };
  } finally {
    if (timeout?.timeoutId) clearTimeout(timeout.timeoutId);
  }
};

export const fetchPageText = async (url, { maxTokens, timeoutMs } = {}) => {
  if (!url) return '';
  const timeout = buildTimeoutSignal(timeoutMs || 10000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/html' },
      signal: timeout?.controller?.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => null);
      throw new Error(`Page fetch failed: ${response.status} ${text || response.statusText}`);
    }
    const html = await response.text();
    const extracted = cleanText(htmlToText(html));
    const trimmed = maxTokens ? trimToTokens(extracted, maxTokens) : extracted;
    return trimmed;
  } catch (error) {
    logger.warn('Page fetch failed', { url, error: error?.message });
    return '';
  } finally {
    if (timeout?.timeoutId) clearTimeout(timeout.timeoutId);
  }
};
