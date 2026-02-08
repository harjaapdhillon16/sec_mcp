import { ingestCompany } from '../workers/ingest.js';
import { precomputeCompany } from '../workers/precompute.js';
import { getCompanyByCik, getCompanyByTicker } from '../db/queries.js';
import { normalizeCik, normalizeTicker } from './utils.js';

const inflight = new Map();
const queue = [];
let running = 0;
const MAX_CONCURRENCY = 1;

const buildKey = ({ ticker, cik }) => {
  const normalizedCik = normalizeCik(cik);
  if (normalizedCik) return `cik:${normalizedCik}`;
  const normalizedTicker = normalizeTicker(ticker);
  if (normalizedTicker) return `ticker:${normalizedTicker}`;
  return null;
};

const resolveCompany = async ({ ticker, cik }) => {
  const normalizedCik = normalizeCik(cik);
  if (normalizedCik) {
    return await getCompanyByCik(normalizedCik);
  }
  const normalizedTicker = normalizeTicker(ticker);
  if (normalizedTicker) {
    return await getCompanyByTicker(normalizedTicker);
  }
  return null;
};

const runNext = () => {
  if (running >= MAX_CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  running += 1;
  const { key, job, resolve } = next;
  job().then(resolve).finally(() => {
    running -= 1;
    inflight.delete(key);
    runNext();
  });
};

export const enqueueIngest = ({ ticker, cik, formType }) => {
  const key = buildKey({ ticker, cik });
  if (!key) {
    return Promise.resolve(false);
  }
  if (inflight.has(key)) {
    return inflight.get(key);
  }
  const promise = new Promise((resolve) => {
    queue.push({
      key,
      resolve,
      job: async () => {
        try {
          const forms = formType ? [formType] : null;
          await ingestCompany({ ticker, cik, forms });
          const company = await resolveCompany({ ticker, cik });
          if (company) {
            await precomputeCompany(company);
          }
        } catch (error) {
        }
      }
    });
    runNext();
  });
  inflight.set(key, promise);
  return promise;
};
