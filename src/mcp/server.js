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
import { buildLatestIntelFallback } from '../lib/fallbackIntel.js';
import { enqueueIngest } from '../lib/ingestQueue.js';

const resolveCompanyFromDb = async ({ ticker, cik }) => {
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
  return null;
};

const resolveCompany = async ({ ticker, cik }) => {
  const company = await resolveCompanyFromDb({ ticker, cik });
  if (company) return company;
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

const buildErrorPayload = (message, code = null, details = null) => ({
  status: 'error',
  error: {
    message,
    code,
    details
  }
});

const errorResponse = (message, code = null, details = null, extraContent = []) => {
  const payload = buildErrorPayload(message, code, details);
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      ...extraContent
    ],
    structuredContent: payload,
    isError: true
  };
};

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const normalizeStructuredContent = (value) => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

const jsonResponse = (structuredContent, extraContent = []) => {
  const normalized = normalizeStructuredContent(structuredContent);
  if (!isPlainObject(normalized)) {
    return errorResponse('Invalid structured content produced by tool', 'invalid_structured_content', null, extraContent);
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(normalized, null, 2) },
      ...extraContent
    ],
    structuredContent: normalized
  };
};

const createStreamLogger = (extra, { intervalMs = 500, maxBuffer = 800 } = {}) => {
  if (!extra?.sendNotification) {
    const noop = () => {};
    noop.flush = () => {};
    return noop;
  }
  let buffer = '';
  let lastFlush = 0;
  const flush = (force = false) => {
    if (!buffer) return;
    const now = Date.now();
    if (!force && now - lastFlush < intervalMs && buffer.length < maxBuffer) return;
    const chunk = buffer;
    buffer = '';
    lastFlush = now;
    extra.sendNotification({
      method: 'notifications/message',
      params: {
        level: 'info',
        logger: 'mcp-fallback',
        data: chunk
      }
    }).catch(() => {});
  };
  const streamLog = (message) => {
    if (!message) return;
    buffer += message;
    const shouldFlush = message.includes('\n') || buffer.length >= maxBuffer;
    flush(shouldFlush);
  };
  streamLog.flush = () => flush(true);
  return streamLog;
};

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
    async ({ ticker, cik, formType, includeSections }, extra) => {
      const log = logger.child({ tool: 'sec_latest_filing_intel', ticker, cik, formType });
      const done = withTimer(log, 'sec_latest_filing_intel');
      const streamLog = createStreamLogger(extra);
      const finish = (result) => {
        done();
        return result;
      };

      try {
        let company = null;
        try {
          company = await resolveCompanyFromDb({ ticker, cik });
        } catch (error) {
          log.warn('Company lookup failed', { error: error?.message });
        }

        let filing = null;
        if (company) {
          try {
            filing = await getLatestFiling(company.cik, formType || null);
          } catch (error) {
            log.warn('Latest filing lookup failed', { error: error?.message });
          }
        }

        if (!company || !filing) {
          streamLog('[fallback] Company or filing missing in DB. Using fallback path.\n');
          enqueueIngest({ ticker, cik, formType }).catch(() => {});
          const fallback = await buildLatestIntelFallback({
            ticker,
            cik,
            formType,
            includeSections,
            streamLog
          });
          const sourcesText = [
            'Note: Fallback generated from SEC + web sources; background ingest/precompute running.',
            'Sources:',
            fallback.sources.primaryDocUrl ? `Filing: ${fallback.sources.primaryDocUrl}` : null,
            fallback.sources.submissionsUrl ? `SEC submissions: ${fallback.sources.submissionsUrl}` : null,
            fallback.sources.factsUrl ? `SEC company facts: ${fallback.sources.factsUrl}` : null
          ].filter(Boolean).join('\n');
          return finish(jsonResponse(fallback.intel, [{ type: 'text', text: sourcesText }]));
        }

        const existing = await getIntelReport(company.cik, filing.id, 'latest_summary');
        if (existing?.data_json) {
          let payload = existing.data_json;
          if (typeof payload === 'string') {
            try {
              payload = JSON.parse(payload);
            } catch {
              // Leave as-is; jsonResponse will surface an error response.
            }
          }
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && !includeSections) {
            payload = { ...payload, sections: [] };
          }
          return finish(jsonResponse(payload));
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
        return finish(jsonResponse(intel));
      } catch (error) {
        log.error('sec_latest_filing_intel failed', { error: error?.message });
        return finish(errorResponse(error?.message || 'Unknown error'));
      } finally {
        streamLog.flush();
      }
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
      const finish = (result) => {
        done();
        return result;
      };
      try {
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
          return finish(jsonResponse(existing.data_json));
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
        return finish(jsonResponse(comparisonIntel));
      } catch (error) {
        log.error('sec_compare_latest_to_previous failed', { error: error?.message });
        return finish(errorResponse(error?.message || 'Unknown error'));
      }
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
      const finish = (result) => {
        done();
        return result;
      };
      try {
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
        return finish(jsonResponse({
          cik: company.cik,
          ticker: company.ticker || null,
          query,
          matches
        }));
      } catch (error) {
        log.error('sec_semantic_search failed', { error: error?.message });
        return finish(errorResponse(error?.message || 'Unknown error'));
      }
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
      const finish = (result) => {
        done();
        return result;
      };
      try {
        const company = await resolveCompany({ ticker, cik });
        const intel = await getEarningsIntel({
          cik: company.cik,
          fiscalYear: year || null,
          fiscalQuarter: quarter || null
        });
        if (!intel) {
          return finish(jsonResponse({
            cik: company.cik,
            ticker: company.ticker || null,
            status: 'not_found',
            callDate: null,
            summary: null,
            tone: null,
            guidanceChanges: [],
            keyQuotes: []
          }));
        }
        return finish(jsonResponse({
          cik: intel.cik,
          ticker: intel.ticker || company.ticker || null,
          status: 'ok',
          callDate: intel.call_date,
          summary: intel.data_json.summary || null,
          tone: intel.data_json.tone || null,
          guidanceChanges: intel.data_json.guidanceChanges || [],
          keyQuotes: intel.data_json.keyQuotes || []
        }));
      } catch (error) {
        log.error('earnings_call_intel failed', { error: error?.message });
        return finish(errorResponse(error?.message || 'Unknown error'));
      }
    }
  );

  return server;
};
