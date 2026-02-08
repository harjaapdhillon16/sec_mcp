#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import minimist from 'minimist';
import { normalizeTicker } from '../lib/utils.js';

const args = minimist(process.argv.slice(2));

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const runBatches = async (items, limit, mapper) => {
  if (!items.length) return [];
  const size = Math.max(1, limit || 1);
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(mapper));
    results.push(...batchResults);
  }
  return results;
};

const loadTickers = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  const tickers = raw
    .split(/\s+/)
    .map(value => normalizeTicker(value))
    .filter(Boolean);
  return [...new Set(tickers)];
};

const main = async () => {
  const filePath = path.resolve(process.cwd(), args.file || 'sp500.txt');
  const companyConcurrency = parseIntSafe(
    args.concurrency ?? process.env.SP500_COMPANY_CONCURRENCY,
    3
  );

  if (!process.env.SEC_MIN_INTERVAL_MS) {
    process.env.SEC_MIN_INTERVAL_MS = '100';
  }

  const tickers = await loadTickers(filePath);

  const { ingestCompany } = await import(new URL('./ingest.js', import.meta.url));
  const { precomputeForTicker } = await import(new URL('./precompute.js', import.meta.url));

  const failures = [];

  const handleTicker = async (ticker) => {
    const attempt = async (value) => {
      await ingestCompany({ ticker: value });
      await precomputeForTicker(value);
    };
    try {
      await attempt(ticker);
    } catch (error) {
      const message = error?.message || String(error);
      if (message.includes('Ticker') && ticker.includes('.')) {
        const alt = ticker.replace(/\./g, '-');
        await attempt(alt);
        return;
      }
      throw error;
    }
  };

  await runBatches(tickers, companyConcurrency, async (ticker) => {
    try {
      await handleTicker(ticker);
    } catch (error) {
      failures.push({ ticker, error: error?.message || String(error) });
    }
  });

  if (failures.length) {
    process.exitCode = 1;
  }
};

main().catch(error => {
  process.exit(1);
});
