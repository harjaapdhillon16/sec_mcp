import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LatestIntelInputSchema,
  LatestIntelOutputSchema,
  CompareInputSchema,
  CompareOutputSchema,
  SemanticSearchInputSchema,
  SemanticSearchOutputSchema,
  EarningsInputSchema,
  EarningsOutputSchema
} from './schemas.js';
import {
  getCompanyByCik,
  getCompanyByTicker,
  getLatestFiling,
  getPreviousFiling,
  getSectionsByFiling,
  getFactsForPeriod,
  getLatestFactsByTag,
  getIntelReport,
  upsertIntelReport,
  getSectionChunks,
  searchChunksByEmbedding,
  getEarningsIntel
} from '../db/queries.js';
import { normalizeCik, normalizeTicker } from '../lib/utils.js';
import { KEY_TAGS, DEFAULT_SECTIONS } from '../lib/constants.js';
import { embedText } from '../lib/embeddings.js';
import { buildLatestIntel, buildComparisonIntel, computeMetricDeltas } from '../lib/intel.js';
import { compareSections } from '../lib/compare.js';
import { logger, withTimer } from '../lib/logger.js';

const resolveCompany = async ({ ticker, cik }) => {
  const normalizedCik = normalizeCik(cik);
  const normalizedTicker = normalizeTicker(ticker);
  if (normalizedCik) {
    const company = await getCompanyByCik(normalizedCik);
    if (company) return company;
  }
  if (normalizedTicker) {
    const company = await getCompanyByTicker(normalizedTicker);
    if (company) return company;
  }
  throw new Error('Company not found. Provide a valid CIK or ticker already ingested.');
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

const jsonResponse = (structuredContent) => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  structuredContent
});

export const createMcpServer = () => {
  const server = new McpServer({
    name: 'sec-filings-intel',
    version: '1.0.0',
    websiteUrl: 'https://example.com'
  }, { capabilities: { logging: {} } });

  server.registerTool(
    'sec_latest_filing_intel',
    {
      title: 'SEC Latest Filing Intel',
      description: 'Return precomputed intelligence for the latest 10-K/10-Q/8-K filing.',
      inputSchema: LatestIntelInputSchema,
      outputSchema: LatestIntelOutputSchema
    },
    async ({ ticker, cik, formType, includeSections }) => {
      const log = logger.child({ tool: 'sec_latest_filing_intel', ticker, cik, formType });
      const done = withTimer(log, 'sec_latest_filing_intel');
      const company = await resolveCompany({ ticker, cik });
      const filing = await getLatestFiling(company.cik, formType || null);
      if (!filing) {
        log.warn('No filings found');
        throw new Error('No filings found for company');
      }
      const existing = await getIntelReport(company.cik, filing.id, 'latest_summary');
      if (existing?.data_json) {
        done();
        const payload = { ...existing.data_json };
        if (!includeSections) payload.sections = [];
        return jsonResponse(payload);
      }
      const sections = await getSectionsByFiling(filing.id);
      const sectionMap = {};
      for (const section of sections) {
        sectionMap[section.section_type] = section.content_text;
      }
      const facts = await buildFactsForFiling(company.cik, filing);
      const previous = await getPreviousFiling(company.cik, filing.form_type, filing.filing_date);
      const previousFacts = previous ? await buildFactsForFiling(company.cik, previous) : [];
      const intel = buildLatestIntel({
        company,
        filing,
        sections: sectionMap,
        facts,
        previousFacts
      });
      if (!includeSections) intel.sections = [];
      await upsertIntelReport({
        cik: company.cik,
        filingId: filing.id,
        reportType: 'latest_summary',
        dataJson: intel
      });
      done();
      return jsonResponse(intel);
    }
  );

  server.registerTool(
    'sec_compare_latest_to_previous',
    {
      title: 'SEC Compare Latest to Previous',
      description: 'Compare the latest filing to the previous comparable filing (YoY/QoQ).',
      inputSchema: CompareInputSchema,
      outputSchema: CompareOutputSchema
    },
    async ({ ticker, cik, formType }) => {
      const log = logger.child({ tool: 'sec_compare_latest_to_previous', ticker, cik, formType });
      const done = withTimer(log, 'sec_compare_latest_to_previous');
      const company = await resolveCompany({ ticker, cik });
      const current = await getLatestFiling(company.cik, formType || null);
      if (!current) {
        log.warn('No filings found');
        throw new Error('No filings found for company');
      }
      const previous = await getPreviousFiling(company.cik, current.form_type, current.filing_date);
      if (!previous) {
        log.warn('No previous filing found');
        throw new Error('No previous comparable filing found');
      }
      const existing = await getIntelReport(company.cik, current.id, 'compare_previous');
      if (existing?.data_json) {
        done();
        return jsonResponse(existing.data_json);
      }
      const currentSections = await getSectionsByFiling(current.id);
      const sectionMap = {};
      for (const section of currentSections) {
        sectionMap[section.section_type] = section.content_text;
      }
      const previousSections = await getSectionsByFiling(previous.id);
      const prevMap = {};
      for (const section of previousSections) {
        prevMap[section.section_type] = section.content_text;
      }
      const facts = await buildFactsForFiling(company.cik, current);
      const previousFacts = await buildFactsForFiling(company.cik, previous);
      const metricDeltas = computeMetricDeltas(facts, previousFacts);
      const narrativeChanges = [];
      for (const sectionType of DEFAULT_SECTIONS) {
        if (!sectionMap[sectionType] || !prevMap[sectionType]) continue;
        const diff = compareSections(sectionMap[sectionType], prevMap[sectionType]);
        const chunkRefs = await getSectionChunks(current.id, sectionType, 3);
        narrativeChanges.push({
          sectionType,
          ...diff,
          citations: chunkRefs.map(chunk => chunk.id)
        });
      }
      const comparisonIntel = buildComparisonIntel({
        company,
        currentFiling: current,
        previousFiling: previous,
        metricDeltas,
        narrativeChanges
      });
      await upsertIntelReport({
        cik: company.cik,
        filingId: current.id,
        reportType: 'compare_previous',
        dataJson: comparisonIntel
      });
      done();
      return jsonResponse(comparisonIntel);
    }
  );

  server.registerTool(
    'sec_semantic_search',
    {
      title: 'SEC Semantic Search',
      description: 'Search filing chunks semantically for a query string.',
      inputSchema: SemanticSearchInputSchema,
      outputSchema: SemanticSearchOutputSchema
    },
    async ({ ticker, cik, query, sectionType, limit }) => {
      const log = logger.child({ tool: 'sec_semantic_search', ticker, cik, sectionType });
      const done = withTimer(log, 'sec_semantic_search');
      const company = await resolveCompany({ ticker, cik });
      const embedding = await embedText(query);
      const rows = await searchChunksByEmbedding({
        cik: company.cik,
        embedding,
        limit: limit || 6,
        sectionType: sectionType || null
      });
      const matches = rows.map(row => ({
        chunkId: row.id,
        filingId: row.filing_id,
        filingDate: row.filing_date,
        formType: row.form_type,
        sectionType: row.section_type,
        score: Number(row.score),
        snippet: row.text.slice(0, 280)
      }));
      done();
      return jsonResponse({
        cik: company.cik,
        ticker: company.ticker || null,
        query,
        matches
      });
    }
  );

  server.registerTool(
    'earnings_call_intel',
    {
      title: 'Earnings Call Intel',
      description: 'Return precomputed intelligence for the latest earnings call transcript.',
      inputSchema: EarningsInputSchema,
      outputSchema: EarningsOutputSchema
    },
    async ({ ticker, cik, year, quarter }) => {
      const log = logger.child({ tool: 'earnings_call_intel', ticker, cik, year, quarter });
      const done = withTimer(log, 'earnings_call_intel');
      const company = await resolveCompany({ ticker, cik });
      const intel = await getEarningsIntel({
        cik: company.cik,
        fiscalYear: year || null,
        fiscalQuarter: quarter || null
      });
      if (!intel) {
        done();
        return jsonResponse({
          cik: company.cik,
          ticker: company.ticker || null,
          status: 'not_found',
          callDate: null,
          summary: null,
          tone: null,
          guidanceChanges: [],
          keyQuotes: []
        });
      }
      done();
      return jsonResponse({
        cik: intel.cik,
        ticker: intel.ticker || company.ticker || null,
        status: 'ok',
        callDate: intel.call_date,
        summary: intel.data_json.summary || null,
        tone: intel.data_json.tone || null,
        guidanceChanges: intel.data_json.guidanceChanges || [],
        keyQuotes: intel.data_json.keyQuotes || []
      });
    }
  );

  return server;
};
