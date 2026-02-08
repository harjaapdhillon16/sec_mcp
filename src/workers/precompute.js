#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import minimist from 'minimist';
import { config } from '../config.js';
import { normalizeTicker } from '../lib/utils.js';
import { KEY_TAGS, DEFAULT_SECTIONS } from '../lib/constants.js';
import { compareSections } from '../lib/compare.js';
import { buildLatestIntel, buildComparisonIntel, computeMetricDeltas } from '../lib/intel.js';
import {
  normalizeCik,
  getCompanyByTicker,
  getCompanyByCik,
  listCompanies,
  getLatestFiling,
  getPreviousFiling,
  getSectionsByFiling,
  getFactsForPeriod,
  getLatestFactsByTag,
  upsertIntelReport,
  upsertComparison,
  getSectionChunks
} from '../db/queries.js';

const args = minimist(process.argv.slice(2));

const tickerArg = args.ticker ? normalizeTicker(args.ticker) : null;
const cikArg = args.cik ? normalizeCik(args.cik) : null;
const processAll = Boolean(args.all);

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

const resolveCompanies = async () => {
  if (processAll) {
    return await listCompanies();
  }
  if (cikArg) {
    const company = await getCompanyByCik(cikArg);
    if (!company) throw new Error(`Company not found for CIK ${cikArg}`);
    return [company];
  }
  if (tickerArg) {
    const company = await getCompanyByTicker(tickerArg);
    if (!company) throw new Error(`Company not found for ticker ${tickerArg}`);
    return [company];
  }
  throw new Error('Provide --cik, --ticker, or --all');
};

const buildFactsForFiling = async (cik, filing) => {
  if (!filing) return [];
  const tags = KEY_TAGS.map(item => item.tag);
  if (filing.report_period) {
    const facts = await getFactsForPeriod(cik, filing.report_period, tags);
    if (facts.length) return facts;
  }
  return await getLatestFactsByTag(cik, tags);
};

export const precomputeCompany = async (company) => {
  const latestFiling = await getLatestFiling(company.cik, null);
  if (!latestFiling) return;
  const [previousFiling, sections] = await Promise.all([
    getPreviousFiling(company.cik, latestFiling.form_type, latestFiling.filing_date),
    getSectionsByFiling(latestFiling.id)
  ]);
  const sectionMap = {};
  for (const section of sections) {
    sectionMap[section.section_type] = section.content_text;
  }
  const prevSectionMap = {};
  const [previousSections, facts, previousFacts] = await Promise.all([
    previousFiling ? getSectionsByFiling(previousFiling.id) : Promise.resolve([]),
    buildFactsForFiling(company.cik, latestFiling),
    previousFiling ? buildFactsForFiling(company.cik, previousFiling) : Promise.resolve([])
  ]);
  for (const section of previousSections) {
    prevSectionMap[section.section_type] = section.content_text;
  }

  const latestIntel = buildLatestIntel({
    company,
    filing: latestFiling,
    sections: sectionMap,
    facts,
    previousFacts
  });

  await upsertIntelReport({
    cik: company.cik,
    filingId: latestFiling.id,
    reportType: 'latest_summary',
    dataJson: latestIntel
  });

  if (!previousFiling) return;
  const metricDeltas = computeMetricDeltas(facts, previousFacts);
  const narrativeChanges = (await Promise.all(
    DEFAULT_SECTIONS.map(async (sectionType) => {
      const currentText = sectionMap[sectionType];
      if (!currentText) return null;
      const previousText = prevSectionMap[sectionType];
      if (!previousText) return null;
      const diff = compareSections(currentText, previousText);
      const chunkRefs = await getSectionChunks(latestFiling.id, sectionType, 3);
      return {
        sectionType,
        ...diff,
        citations: chunkRefs.map(chunk => chunk.id)
      };
    })
  )).filter(Boolean);

  const comparisonIntel = buildComparisonIntel({
    company,
    currentFiling: latestFiling,
    previousFiling,
    metricDeltas,
    narrativeChanges
  });

  await Promise.all([
    upsertComparison({
      cik: company.cik,
      currentFilingId: latestFiling.id,
      previousFilingId: previousFiling.id,
      diffJson: comparisonIntel
    }),
    upsertIntelReport({
      cik: company.cik,
      filingId: latestFiling.id,
      reportType: 'compare_previous',
      dataJson: comparisonIntel
    })
  ]);
};

export const precomputeForTicker = async (ticker) => {
  const normalized = normalizeTicker(ticker);
  const company = await getCompanyByTicker(normalized);
  if (!company) throw new Error(`Company not found for ticker ${normalized}`);
  await precomputeCompany(company);
};

const run = async () => {
  const companies = await resolveCompanies();
  await runBatches(companies, config.precomputeConcurrency, async (company) => {
    await precomputeCompany(company);
  });
};

const isCli = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  run().catch(error => {
    process.exit(1);
  });
}
