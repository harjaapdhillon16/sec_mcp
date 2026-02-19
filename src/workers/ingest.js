#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { config } from '../config.js';
import { getCompanyFacts, getCompanyTickerMap, getSubmissions, fetchFilingDocument, buildPrimaryDocUrl } from '../lib/sec.js';
import { htmlToText, extractSections } from '../lib/filingParser.js';
import { chunkText } from '../lib/chunker.js';
import { embedTexts } from '../lib/embeddings.js';
import { sha256, cleanText, normalizeTicker } from '../lib/utils.js';
import { KEY_TAGS } from '../lib/constants.js';
import {
  normalizeCik,
  upsertCompany,
  getCompanyByTicker,
  getCompanyByCik,
  upsertFiling,
  getFilingByAccession,
  getSectionByFiling,
  upsertFilingSection,
  deleteChunksForSection,
  insertFilingChunks,
  insertXbrlFacts,
  listRecentFilings
} from '../db/queries.js';

const args = minimist(process.argv.slice(2));

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

let cachedTickerMap = null;

const getTickerMap = async () => {
  if (!cachedTickerMap) {
    cachedTickerMap = await getCompanyTickerMap();
  }
  return cachedTickerMap;
};

const resolveCik = async ({ tickerArg, cikArg }) => {
  if (cikArg) return cikArg;
  if (!tickerArg) throw new Error('Provide --cik or --ticker');
  const cached = await getCompanyByTicker(tickerArg);
  if (cached) return cached.cik;
  const map = await getTickerMap();
  const entries = Object.values(map);
  const match = entries.find(entry => String(entry.ticker).toUpperCase() === tickerArg);
  if (!match) throw new Error(`Ticker ${tickerArg} not found in SEC mapping`);
  const cik = normalizeCik(String(match.cik_str));
  await upsertCompany({ cik, ticker: tickerArg, name: match.title });
  return cik;
};

const buildFacts = (cik, factsJson, filings) => {
  const facts = [];
  const filingByPeriod = new Map();
  for (const filing of filings) {
    if (filing.report_period) {
      filingByPeriod.set(filing.report_period, filing.id);
    }
  }
  const usGaap = factsJson?.facts?.['us-gaap'] || {};
  for (const { tag } of KEY_TAGS) {
    const tagData = usGaap[tag];
    if (!tagData?.units) continue;
    for (const [unit, items] of Object.entries(tagData.units)) {
      for (const item of items) {
        const value = typeof item.val === 'number' ? item.val : Number(item.val);
        if (!Number.isFinite(value)) continue;
        facts.push({
          cik,
          filingId: filingByPeriod.get(item.end) || null,
          tag,
          unit,
          startDate: item.start || null,
          endDate: item.end || null,
          fy: item.fy || null,
          fp: item.fp || null,
          value
        });
      }
    }
  }
  return facts;
};

export const ingestCompany = async ({
  ticker,
  cik,
  forms,
  force: forceFlag
} = {}) => {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const tickerArg = ticker ? normalizeTicker(ticker) : null;
  const cikArg = cik ? normalizeCik(cik) : null;
  const formFilter = Array.isArray(forms) && forms.length
    ? forms
    : ['10-K', '10-Q', '8-K'];
  const force = Boolean(forceFlag);
  const cikResolved = await resolveCik({ tickerArg, cikArg });
  const submissions = await getSubmissions(cikResolved);
  const companyName = submissions?.name || null;
  await upsertCompany({ cik: cikResolved, ticker: tickerArg, name: companyName });
  const recent = submissions?.filings?.recent;
  if (!recent) throw new Error('No recent filings found');

  const filingsToProcess = [];
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const accession = recent.accessionNumber[i];
    const formType = recent.form[i];
    if (!formFilter.includes(formType)) continue;
    filingsToProcess.push({
      accession,
      formType,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] || null,
      primaryDocument: recent.primaryDocument?.[i] || null
    });
  }

  const processSection = async (filing, sectionType, contentText) => {
    const cleaned = cleanText(contentText);
    if (!cleaned) return null;
    const hash = sha256(cleaned);
    const existingSection = await getSectionByFiling(filing.id, sectionType);
    if (existingSection && existingSection.content_hash === hash && !force) {
      return null;
    }
    await upsertFilingSection({
      filingId: filing.id,
      sectionType,
      contentText: cleaned,
      contentHash: hash
    });
    await deleteChunksForSection(filing.id, sectionType);
    const chunks = chunkText(cleaned, config.chunkMaxWords, config.chunkOverlapWords, config.embeddingMaxTokens);
    if (!chunks.length) return null;
    const embeddings = await embedTexts(chunks.map(chunk => chunk.text));
    const rows = chunks.map((chunk, index) => ({
      filingId: filing.id,
      sectionType,
      chunkIndex: index,
      text: chunk.text,
      chunkHash: sha256(chunk.text),
      embedding: embeddings[index],
      tokenCount: chunk.tokenCount
    }));
    await insertFilingChunks(rows);
    return null;
  };

  const processFiling = async (filingMeta) => {
    const existing = await getFilingByAccession(filingMeta.accession);
    if (existing && !force) return null;
    const primaryDocUrl = filingMeta.primaryDocument
      ? buildPrimaryDocUrl(cikResolved, filingMeta.accession, filingMeta.primaryDocument)
      : null;
    let rawText = null;
    if (primaryDocUrl) {
      const html = await fetchFilingDocument(primaryDocUrl);
      rawText = htmlToText(html);
    }
    const filing = await upsertFiling({
      cik: cikResolved,
      accession: filingMeta.accession,
      formType: filingMeta.formType,
      filingDate: filingMeta.filingDate,
      reportPeriod: filingMeta.reportDate,
      primaryDocUrl,
      rawText
    });

    if (!rawText) return null;
    const sections = extractSections(rawText);
    const entries = Object.entries(sections);
    await runBatches(entries, config.ingestSectionConcurrency, ([sectionType, contentText]) =>
      processSection(filing, sectionType, contentText)
    );
    return null;
  };

  await runBatches(filingsToProcess, config.ingestFilingConcurrency, processFiling);

  const filings = await listRecentFilings(cikResolved, 25);
  const factsJson = await getCompanyFacts(cikResolved);
  const facts = buildFacts(cikResolved, factsJson, filings);
  await insertXbrlFacts(facts);
};

const ingest = async () => {
  const formFilter = args.forms ? String(args.forms).split(',').map(v => v.trim()).filter(Boolean) : null;
  await ingestCompany({
    ticker: args.ticker,
    cik: args.cik,
    forms: formFilter,
    force: args.force
  });
};

const isCli = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  ingest().catch(() => {
    process.exit(1);
  });
}
