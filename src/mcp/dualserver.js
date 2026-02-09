import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  LatestIntelInputSchema,
  LatestIntelOutputSchema,
  CompareInputSchema,
  CompareOutputSchema,
  SemanticSearchInputSchema,
  SemanticSearchOutputSchema,
  EarningsInputSchema,
  EarningsOutputSchema,
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
  getEarningsIntel,
} from '../db/queries.js';

import { normalizeCik, normalizeTicker } from '../lib/utils.js';
import { KEY_TAGS, DEFAULT_SECTIONS } from '../lib/constants.js';
import { embedText } from '../lib/embeddings.js';

import {
  buildLatestIntel,
  buildComparisonIntel,
  computeMetricDeltas,
} from '../lib/intel.js';

import { compareSections } from '../lib/compare.js';
import { logger as rootLogger } from '../lib/logger.js';
import { buildLatestIntelFallback } from '../lib/fallbackIntel.js';
import { enqueueIngest } from '../lib/ingestQueue.js';
import { extractSections } from '../lib/filingParser.js';
import { Server } from '@modelcontextprotocol/sdk/server';

/* -------------------------------------------------------------------------- */
/*                                   TOOLS                                    */
/* -------------------------------------------------------------------------- */

const TOOLS = [
  {
    name: 'sec_latest_filing_intel',
    description:
      'Return precomputed intelligence for the latest 10-K/10-Q/8-K filing.',
    inputSchema: LatestIntelInputSchema,
    outputSchema: LatestIntelOutputSchema,
  },
  {
    name: 'sec_compare_latest_to_previous',
    description:
      'Compare the latest filing to the previous comparable filing (YoY/QoQ).',
    inputSchema: CompareInputSchema,
    outputSchema: CompareOutputSchema,
  },
  {
    name: 'sec_semantic_search',
    description: 'Search filing chunks semantically for a query string.',
    inputSchema: SemanticSearchInputSchema,
    outputSchema: SemanticSearchOutputSchema,
  },
];

/* -------------------------------------------------------------------------- */
/*                            COMPANY RESOLUTION                              */
/* -------------------------------------------------------------------------- */

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

  throw new Error(
    'Company not found. Provide a valid CIK or ticker already ingested.'
  );
};

/* -------------------------------------------------------------------------- */
/*                               FACT BUILDERS                                */
/* -------------------------------------------------------------------------- */

const buildFactsForFiling = async (cik, filing) => {
  if (!filing) return [];

  const tags = KEY_TAGS.map((item) => item.tag);

  if (filing.report_period) {
    const facts = await getFactsForPeriod(cik, filing.report_period, tags);
    if (facts.length) return facts;
  }

  return getLatestFactsByTag(cik, tags);
};

const buildSectionMapForFiling = async (filing) => {
  if (!filing) return {};
  const sections = await getSectionsByFiling(filing.id);
  if (sections?.length) {
    const sectionMap = {};
    for (const section of sections) {
      sectionMap[section.section_type] = section.content_text;
    }
    return sectionMap;
  }
  if (filing.raw_text) {
    return extractSections(filing.raw_text);
  }
  return {};
};

/* -------------------------------------------------------------------------- */
/*                              RESPONSE HELPERS                              */
/* -------------------------------------------------------------------------- */

const buildErrorPayload = (message, code = null, details = null) => ({
  status: 'error',
  error: { message, code, details },
});

const logResponse = (logger, response) => {
  if (!logger) return response;

  try {
    logger.info('MCP response', { response });
  } catch {
    // ignore logging failures
  }

  return response;
};

const errorResponse = (
  logger,
  message,
  code = null,
  details = null,
  extraContent = []
) => {
  const payload = buildErrorPayload(message, code, details);

  const response = {
    content: [{ type: 'text', text: message || 'Error' }, ...extraContent],
    structuredContent: payload,
    isError: true,
  };

  return logResponse(logger, response);
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

const buildTextContent = (value) => {
  if (!value || typeof value !== 'object') return '';
  if (value.status === 'error' && value.error?.message) {
    return String(value.error.message);
  }
  return 'OK';
};

const jsonResponse = (logger, structuredContent, extraContent = []) => {
  const normalized = normalizeStructuredContent(structuredContent);

  if (!isPlainObject(normalized)) {
    return errorResponse(
      logger,
      'Invalid structured content produced by tool',
      'invalid_structured_content',
      null,
      extraContent
    );
  }

  const textContent = buildTextContent(normalized);

  const content = textContent
    ? [{ type: 'text', text: textContent }, ...extraContent]
    : [...extraContent];

  const response = { content, structuredContent: normalized };

  return logResponse(logger, response);
};

/* -------------------------------------------------------------------------- */
/*                              STREAM LOGGER                                 */
/* -------------------------------------------------------------------------- */

const createStreamLogger = (
  extra,
  { intervalMs = 500, maxBuffer = 800 } = {}
) => {
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
    if (!force && now - lastFlush < intervalMs && buffer.length < maxBuffer)
      return;

    const chunk = buffer;
    buffer = '';
    lastFlush = now;

    extra
      .sendNotification({
        method: 'notifications/message',
        params: { level: 'info', logger: 'mcp-fallback', data: chunk },
      })
      .catch(() => {});
  };

  const streamLog = (message) => {
    if (!message) return;

    buffer += message;

    const shouldFlush =
      message.includes('\n') || buffer.length >= maxBuffer;

    flush(shouldFlush);
  };

  streamLog.flush = () => flush(true);

  return streamLog;
};

/* -------------------------------------------------------------------------- */
/*                                HANDLERS                                    */
/* -------------------------------------------------------------------------- */

const handleLatestIntel = async (args, extra, logger) => {
  const { ticker, cik, formType, includeSections } = args || {};
  const wantSections = Boolean(includeSections);
  const streamLog = createStreamLogger(extra);

  try {
    let company = null;

    try {
      company = await resolveCompanyFromDb({ ticker, cik });
    } catch {}

    let filing = null;

    if (company) {
      try {
        filing = await getLatestFiling(company.cik, formType || null);
      } catch {}
    }

    if (!company || !filing) {
      streamLog(
        '[fallback] Company or filing missing in DB. Using fallback path.\n'
      );

      enqueueIngest({ ticker, cik, formType }).catch(() => {});

      const fallback = await buildLatestIntelFallback({
        ticker,
        cik,
        formType,
        includeSections,
        streamLog,
      });

      const sourcesText = [
        'Note: Fallback generated from SEC + web sources; background ingest/precompute running.',
        'Sources:',
        fallback.sources.primaryDocUrl
          ? `Filing: ${fallback.sources.primaryDocUrl}`
          : null,
        fallback.sources.submissionsUrl
          ? `SEC submissions: ${fallback.sources.submissionsUrl}`
          : null,
        fallback.sources.factsUrl
          ? `SEC company facts: ${fallback.sources.factsUrl}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');

      return jsonResponse(logger, fallback.intel, [
        { type: 'text', text: sourcesText },
      ]);
    }

    const existing = await getIntelReport(
      company.cik,
      filing.id,
      'latest_summary'
    );

    if (existing?.data_json) {
      let payload = existing.data_json;

      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {}
      }

      const isObject =
        payload && typeof payload === 'object' && !Array.isArray(payload);

      if (!isObject) {
        return jsonResponse(logger, payload);
      }

      if (!wantSections) {
        return jsonResponse(logger, { ...payload, sections: [] });
      }

      const hasStoredSections =
        Array.isArray(payload.sections) && payload.sections.length > 0;
      if (hasStoredSections) {
        return jsonResponse(logger, payload);
      }

      const sectionMap = await buildSectionMapForFiling(filing);
      const hasSectionContent = DEFAULT_SECTIONS.some(
        (sectionType) => sectionMap[sectionType]
      );
      if (hasSectionContent) {
        const facts = await buildFactsForFiling(company.cik, filing);
        const previous = await getPreviousFiling(
          company.cik,
          filing.form_type,
          filing.filing_date
        );
        const previousFacts = previous
          ? await buildFactsForFiling(company.cik, previous)
          : [];

        const rebuilt = buildLatestIntel({
          company,
          filing,
          sections: sectionMap,
          facts,
          previousFacts,
        });

        await upsertIntelReport({
          cik: company.cik,
          filingId: filing.id,
          reportType: 'latest_summary',
          dataJson: rebuilt,
        });

        return jsonResponse(logger, rebuilt);
      }

      if (!Array.isArray(payload.sections)) {
        payload = { ...payload, sections: [] };
      }

      return jsonResponse(logger, payload);
    }

    const sectionMap = await buildSectionMapForFiling(filing);

    const facts = await buildFactsForFiling(company.cik, filing);

    const previous = await getPreviousFiling(
      company.cik,
      filing.form_type,
      filing.filing_date
    );

    const previousFacts = previous
      ? await buildFactsForFiling(company.cik, previous)
      : [];

    const intel = buildLatestIntel({
      company,
      filing,
      sections: sectionMap,
      facts,
      previousFacts,
    });

    await upsertIntelReport({
      cik: company.cik,
      filingId: filing.id,
      reportType: 'latest_summary',
      dataJson: intel,
    });

    const responsePayload = wantSections
      ? intel
      : { ...intel, sections: [] };

    return jsonResponse(logger, responsePayload);
  } catch (error) {
    return errorResponse(logger, error?.message || 'Unknown error');
  } finally {
    streamLog.flush();
  }
};

const handleCompareLatest = async (args, logger) => {
  const { ticker, cik, formType } = args || {};
  
  try {
    const company = await resolveCompany({ ticker, cik });
    const current = await getLatestFiling(company.cik, formType || null);
    
    if (!current) {
      logger?.warn('No filings found');
      throw new Error('No filings found for company');
    }
    
    const previous = await getPreviousFiling(
      company.cik,
      current.form_type,
      current.filing_date
    );
    
    if (!previous) {
      logger?.warn('No previous filing found');
      throw new Error('No previous comparable filing found');
    }
    
    const existing = await getIntelReport(
      company.cik,
      current.id,
      'compare_previous'
    );
    
    if (existing?.data_json) {
      return jsonResponse(logger, existing.data_json);
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
      const diff = compareSections(
        sectionMap[sectionType],
        prevMap[sectionType]
      );
      const chunkRefs = await getSectionChunks(current.id, sectionType, 3);
      narrativeChanges.push({
        sectionType,
        ...diff,
        citations: chunkRefs.map((chunk) => chunk.id),
      });
    }
    
    const comparisonIntel = buildComparisonIntel({
      company,
      currentFiling: current,
      previousFiling: previous,
      metricDeltas,
      narrativeChanges,
    });
    
    await upsertIntelReport({
      cik: company.cik,
      filingId: current.id,
      reportType: 'compare_previous',
      dataJson: comparisonIntel,
    });
    
    return jsonResponse(logger, comparisonIntel);
  } catch (error) {
    logger?.error('sec_compare_latest_to_previous failed', {
      error: error?.message,
    });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleSemanticSearch = async (args, logger) => {
  const {
    ticker,
    cik,
    query,
    sectionType,
    limit,
    minFilingDate,
    maxFilingDate,
  } = args || {};
  
  try {
    const company = await resolveCompany({ ticker, cik });
    const embedding = await embedText(query);
    
    const rows = await searchChunksByEmbedding({
      cik: company.cik,
      embedding,
      limit: limit || 6,
      sectionType: sectionType || null,
      minFilingDate: minFilingDate || null,
      maxFilingDate: maxFilingDate || null,
    });
    
    const matches = rows.map((row) => ({
      chunkId: row.id,
      filingId: row.filing_id,
      filingDate: row.filing_date,
      formType: row.form_type,
      sectionType: row.section_type,
      score: Number(row.score),
      snippet: row.text.slice(0, 280),
    }));
    
    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      query,
      matches,
    });
  } catch (error) {
    logger?.error('sec_semantic_search failed', {
      error: error?.message,
    });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

/* -------------------------------------------------------------------------- */
/*                               MCP SERVER                                   */
/* -------------------------------------------------------------------------- */

export const createMcpServer = ({ logger: baseLogger = rootLogger } = {}) => {
  const server = new Server(
    {
      name: 'sec-filings-intel',
      version: '1.0.0',
      websiteUrl: 'https://example.com',
    },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'sec_latest_filing_intel':
        return handleLatestIntel(args, extra, baseLogger);

      case 'sec_compare_latest_to_previous':
        return handleCompareLatest(args, baseLogger);

      case 'sec_semantic_search':
        return handleSemanticSearch(args, baseLogger);

      default:
        return errorResponse(baseLogger, `Unknown tool: ${name}`);
    }
  });

  return server;
};
