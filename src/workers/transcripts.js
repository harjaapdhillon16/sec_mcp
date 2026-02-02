#!/usr/bin/env node
import fs from 'node:fs/promises';
import minimist from 'minimist';
import { normalizeTicker, normalizeCik } from '../lib/utils.js';
import { ingestEarningsTranscript } from '../lib/earningsPipeline.js';
import { logger, withTimer } from '../lib/logger.js';
import {
  upsertCompany,
  getCompanyByTicker,
  getCompanyByCik,
} from '../db/queries.js';

const args = minimist(process.argv.slice(2));

const filePath = args.file || null;
const tickerArg = args.ticker ? normalizeTicker(args.ticker) : null;
const cikArg = args.cik ? normalizeCik(args.cik) : null;

const loadTranscript = async () => {
  if (!filePath) {
    throw new Error('Provide --file with transcript JSON or text');
  }
  const content = await fs.readFile(filePath, 'utf8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(content);
  }
  return { transcriptText: content };
};

const resolveCompany = async (ticker, cik) => {
  if (cik) {
    const company = await getCompanyByCik(cik);
    if (company) return company;
  }
  if (ticker) {
    const company = await getCompanyByTicker(ticker);
    if (company) return company;
  }
  if (!cik && !ticker) {
    throw new Error('Provide --ticker or --cik (or include in JSON)');
  }
  return await upsertCompany({ cik: cik || null, ticker: ticker || null, name: null });
};

const run = async () => {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const log = logger.child({ worker: 'transcripts', ticker: tickerArg, cik: cikArg });
  const done = withTimer(log, 'transcripts');
  const data = await loadTranscript();
  const ticker = data.ticker ? normalizeTicker(data.ticker) : tickerArg;
  const cik = data.cik ? normalizeCik(data.cik) : cikArg;
  const company = await resolveCompany(ticker, cik);

  const callDate = data.callDate || data.date || null;
  const fiscalYear = data.fiscalYear || data.year || null;
  const fiscalQuarter = data.fiscalQuarter || data.quarter || null;
  const transcriptText = data.transcriptText || data.text || '';

  await ingestEarningsTranscript({
    cik: company.cik,
    ticker: company.ticker,
    callDate,
    fiscalYear,
    fiscalQuarter,
    transcriptText,
    source: data.source || 'file'
  });

  log.info('Transcript processed', { ticker: company.ticker, cik: company.cik });
  done();
};

run().catch(error => {
  console.error('Transcript ingest failed:', error);
  process.exit(1);
});
