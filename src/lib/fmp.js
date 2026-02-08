import { config } from '../config.js';

const baseUrl = 'https://financialmodelingprep.com/stable';

const fmpFetch = async (path, params = {}) => {
  if (!config.fmpApiKey) {
    throw new Error('FMP_API_KEY is not set');
  }
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, value);
  }
  url.searchParams.set('apikey', config.fmpApiKey);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text().catch(() => null);
    throw new Error(`FMP request failed ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
};

const toQuarterNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).toUpperCase();
  const match = text.match(/Q([1-4])/);
  if (match) return Number(match[1]);
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDateValue = (value) => {
  if (!value) return null;
  const date = new Date(value);
  const ms = Number.isNaN(date.getTime()) ? null : date.getTime();
  return ms;
};

const extractArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
};

// API functions
export const fetchTranscriptDates = async (symbol) => {
  return fmpFetch('/earning-call-transcript-dates', { symbol });
};

export const fetchTranscript = async (symbol, year, quarter) => {
  // FIX: quarter should be string (not number) per API docs
  return fmpFetch('/earning-call-transcript', { 
    symbol, 
    year: String(year), 
    quarter: String(quarter),
    limit: 1 
  });
};

// NEW: Latest transcripts API
export const fetchLatestTranscripts = async (limit = 100, page = 0) => {
  return fmpFetch('/earning-call-transcript-latest', { 
    limit: Math.min(limit, 100), 
    page 
  });
};

// NEW: Available symbols API
export const fetchAvailableTranscriptSymbols = async () => {
  return fmpFetch('/earnings-transcript-list');
};

export const pickLatestTranscriptDate = (payload) => {
  const items = extractArray(payload);
  if (!items.length) return null;
  
  const scored = items.map(item => {
    // FIX: Handle the API response structure properly
    const dateValue = item.date || item.filingDate || null;
    const dateMs = normalizeDateValue(dateValue);
    
    // FIX: Use fiscalYear for year (per API response example)
    const year = Number(item.fiscalYear || item.year || null);
    
    // FIX: Use period for quarter (per API response example)
    const quarter = toQuarterNumber(item.period || item.quarter || null);
    
    const yearScore = Number.isFinite(year) ? year : 0;
    const quarterScore = Number.isFinite(quarter) ? quarter : 0;
    const fallbackScore = (yearScore * 10) + quarterScore;
    
    return {
      raw: item,
      year: Number.isFinite(year) ? year : null,
      quarter: Number.isFinite(quarter) ? quarter : null,
      date: dateValue || null,
      score: dateMs || fallbackScore
    };
  });
  
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
};

export const extractTranscriptText = (payload) => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  
  const items = extractArray(payload);
  if (items.length) {
    const record = items[0] || {};
    if (typeof record.content === 'string') return record.content;
    if (typeof record.transcript === 'string') return record.transcript;
    if (typeof record.text === 'string') return record.text;
  }
  
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.transcript === 'string') return payload.transcript;
  if (typeof payload.text === 'string') return payload.text;
  
  return '';
};

// NEW: Helper to get transcript for latest available date
export const fetchLatestTranscript = async (symbol) => {
  try {
    // Get available dates
    const dates = await fetchTranscriptDates(symbol);
    if (!dates || dates.length === 0) {
      throw new Error(`No transcript dates available for ${symbol}`);
    }
    
    // Find the most recent date
    const latest = pickLatestTranscriptDate(dates);
    if (!latest) {
      throw new Error(`Could not determine latest transcript date for ${symbol}`);
    }
    
    // Fetch transcript for the latest date
    const transcript = await fetchTranscript(symbol, latest.year, latest.quarter);
    
    return {
      ...transcript,
      date: latest.date,
      year: latest.year,
      quarter: latest.quarter
    };
  } catch (error) {
    throw error;
  }
};
