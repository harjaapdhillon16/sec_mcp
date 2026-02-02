import { config } from '../config.js';
import { sleep } from './utils.js';
import { logger } from './logger.js';

let lastRequestAt = 0;
let secQueue = Promise.resolve();

const enqueueSec = (task) => {
  const run = secQueue.then(task, task);
  secQueue = run.catch(() => {});
  return run;
};

const secFetch = async (url, options = {}) => {
  if (!config.secUserAgent) {
    throw new Error('SEC_USER_AGENT is required for SEC requests');
  }
  return enqueueSec(async () => {
    logger.debug('SEC request', { url });
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (elapsed < config.secMinIntervalMs) {
      await sleep(config.secMinIntervalMs - elapsed);
    }
    lastRequestAt = Date.now();
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': config.secUserAgent,
        Accept: options.headers?.Accept || 'application/json',
        ...options.headers
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => null);
      throw new Error(`SEC request failed ${response.status}: ${text || response.statusText}`);
    }
    return response;
  });
};

export const getSubmissions = async (cik) => {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const response = await secFetch(url);
  return response.json();
};

export const getCompanyFacts = async (cik) => {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const response = await secFetch(url);
  return response.json();
};

export const getCompanyTickerMap = async () => {
  const url = 'https://www.sec.gov/files/company_tickers.json';
  const response = await secFetch(url);
  return response.json();
};

export const fetchFilingDocument = async (url) => {
  const response = await secFetch(url, {
    headers: { Accept: 'text/html' }
  });
  return response.text();
};

export const buildPrimaryDocUrl = (cik, accession, primaryDoc) => {
  const cikNumeric = String(parseInt(cik, 10));
  const accessionNoDashes = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accessionNoDashes}/${primaryDoc}`;
};
