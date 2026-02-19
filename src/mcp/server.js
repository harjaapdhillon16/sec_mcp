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
  CrossCompanyScanInputSchema,
  CrossCompanyScanOutputSchema,
  DerivedMetricsInputSchema,
  DerivedMetricsOutputSchema,
  ManagementCredibilityInputSchema,
  ManagementCredibilityOutputSchema,
  FilingAnomalyInputSchema,
  FilingAnomalyOutputSchema,
  EarningsQaInputSchema,
  EarningsQaOutputSchema,
  LongitudinalToneInputSchema,
  LongitudinalToneOutputSchema,
  SectorDriftInputSchema,
  SectorDriftOutputSchema,
  CompanyMentionsInputSchema,
  CompanyMentionsOutputSchema,
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
  getEarningsCall,
  getAllEarningsIntel,
  getFilingHistory,
  searchChunksCrossCompany,
  searchTextInChunks,
  listCompanies,
} from '../db/queries.js';

import {
  normalizeCik,
  normalizeTicker,
  splitSentences,
  tokenizeWords,
} from '../lib/utils.js';
import {
  KEY_TAGS,
  DEFAULT_SECTIONS,
  HEDGING_TERMS,
  GOING_CONCERN_TERMS,
  ACCOUNTING_CHANGE_TERMS,
  RELATED_PARTY_TERMS,
} from '../lib/constants.js';
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
  {
    name: 'sec_cross_company_scan',
    description:
      "Semantic search across ALL ingested companies' filings for a concept or signal. " +
      'Returns matches grouped by company. Use to find which companies discuss ' +
      'supply chain risk, tariff exposure, AI investments, or any other theme — sector-wide.',
    inputSchema: CrossCompanyScanInputSchema,
    outputSchema: CrossCompanyScanOutputSchema,
  },
  {
    name: 'sec_derived_metrics',
    description:
      'Compute proprietary financial metrics not in standard XBRL filings: ' +
      'gross/operating/net margins, free cash flow, real FCF (ex-SBC), ' +
      'Rule of 40, R&D intensity, CapEx intensity, debt-to-CFO, goodwill ratio.',
    inputSchema: DerivedMetricsInputSchema,
    outputSchema: DerivedMetricsOutputSchema,
  },
  {
    name: 'sec_management_credibility',
    description:
      'Analyze management tone and communication quality across earnings calls. ' +
      'Tracks hedging language density, tone progression (improving/deteriorating), ' +
      'and guidance history to assess management credibility over time.',
    inputSchema: ManagementCredibilityInputSchema,
    outputSchema: ManagementCredibilityOutputSchema,
  },
  {
    name: 'sec_filing_anomaly',
    description:
      'Detect statistically unusual patterns in the latest filing vs. company history. ' +
      'Flags: risk section expansion, going concern language, material weaknesses, ' +
      'accounting policy changes, related party transactions.',
    inputSchema: FilingAnomalyInputSchema,
    outputSchema: FilingAnomalyOutputSchema,
  },
  {
    name: 'sec_earnings_qa',
    description:
      'Deep analysis of the Q&A section of an earnings call transcript. ' +
      'Extracts analyst questions, detects management deflections, identifies ' +
      'first-time topic mentions, and surfaces top analyst concern themes.',
    inputSchema: EarningsQaInputSchema,
    outputSchema: EarningsQaOutputSchema,
  },
  {
    name: 'sec_longitudinal_tone',
    description:
      'Track management tone, hedging language, and guidance count across multiple ' +
      'earnings call quarters. Shows whether communication quality is improving, ' +
      'stable, or deteriorating over time.',
    inputSchema: LongitudinalToneInputSchema,
    outputSchema: LongitudinalToneOutputSchema,
  },
  {
    name: 'sec_sector_drift',
    description:
      'Detect emerging language patterns across all ingested filings. ' +
      'Finds which companies recently started using a specific term or phrase, ' +
      'revealing sector-level trends (e.g. "tariff", "AI", "impairment") ' +
      'before they become consensus. Returns drift score and affected companies.',
    inputSchema: SectorDriftInputSchema,
    outputSchema: SectorDriftOutputSchema,
  },
  {
    name: 'sec_company_mentions',
    description:
      "Extract company relationships from a filing's text. Identifies other SEC-registered " +
      'companies mentioned as customers, suppliers, partners, or competitors. ' +
      'Also surfaces relationship-indicating sentences (concentration risk, joint ventures, etc.).',
    inputSchema: CompanyMentionsInputSchema,
    outputSchema: CompanyMentionsOutputSchema,
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
/*                        DERIVED METRICS COMPUTATION                         */
/* -------------------------------------------------------------------------- */

const computeDerivedMetrics = (facts, previousFacts = []) => {
  const get = (tags) => {
    for (const tag of Array.isArray(tags) ? tags : [tags]) {
      const f = facts.find((f) => f.tag === tag);
      if (f?.value != null && Number.isFinite(Number(f.value))) return Number(f.value);
    }
    return null;
  };

  const prevGet = (tags) => {
    for (const tag of Array.isArray(tags) ? tags : [tags]) {
      const f = previousFacts.find((f) => f.tag === tag);
      if (f?.value != null && Number.isFinite(Number(f.value))) return Number(f.value);
    }
    return null;
  };

  const revenue = get(['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);
  const grossProfit = get(['GrossProfit']);
  const operatingIncome = get(['OperatingIncomeLoss']);
  const netIncome = get(['NetIncomeLoss']);
  const ocf = get(['NetCashProvidedByUsedInOperatingActivities']);
  const capex = get(['CapitalExpenditures', 'PaymentsToAcquirePropertyPlantAndEquipment']);
  const ltDebt = get(['LongTermDebt']);
  const sbc = get(['ShareBasedCompensation']);
  const rd = get(['ResearchAndDevelopmentExpense']);
  const goodwill = get(['Goodwill']);
  const totalAssets = get(['Assets']);
  const prevRevenue = prevGet(['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);

  const results = [];
  const missing = [];

  const add = (name, value, formula, description, confidence = 'high') => {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      results.push({
        name,
        value: Math.round(value * 10000) / 10000,
        formula,
        description,
        confidence,
      });
    }
  };

  if (revenue && grossProfit) {
    add('Gross Margin', grossProfit / revenue, 'Gross Profit / Revenue', 'Revenue retained after cost of goods sold');
  } else {
    missing.push('Gross Margin (needs: ' + (!revenue ? 'Revenue' : 'Gross Profit') + ')');
  }

  if (revenue && operatingIncome) {
    add('Operating Margin', operatingIncome / revenue, 'Operating Income / Revenue', 'Profitability after all operating expenses');
  }

  if (revenue && netIncome) {
    add('Net Margin', netIncome / revenue, 'Net Income / Revenue', 'Bottom-line profitability ratio');
  }

  const fcf = ocf != null && capex != null ? ocf - Math.abs(capex) : null;

  if (fcf !== null) {
    add('Free Cash Flow', fcf, 'Operating Cash Flow − CapEx', 'Cash generated after capital expenditure');
    if (revenue) {
      add('FCF Margin', fcf / revenue, 'Free Cash Flow / Revenue', 'FCF as % of revenue');
    }
    if (sbc != null) {
      const realFcf = fcf - sbc;
      add('Real FCF (ex-SBC)', realFcf, 'FCF − Stock-Based Compensation', 'FCF adjusted for dilutive SBC — truer economic cash generation');
      if (revenue) {
        add('Real FCF Margin', realFcf / revenue, 'Real FCF / Revenue', 'Adjusted FCF margin removing SBC accounting impact');
      }
    } else {
      missing.push('Real FCF (needs: ShareBasedCompensation — re-run ingest to capture new tags)');
    }
  } else {
    missing.push('Free Cash Flow (needs: ' + (!ocf ? 'Operating Cash Flow' : 'CapEx') + ')');
  }

  if (fcf !== null && revenue && prevRevenue) {
    const revenueGrowth = (revenue - prevRevenue) / Math.abs(prevRevenue);
    add(
      'Rule of 40',
      revenueGrowth + (revenue ? fcf / revenue : 0),
      'Revenue Growth % + FCF Margin',
      'SaaS health metric — values above 0.40 are considered strong'
    );
  }

  if (ltDebt != null && ocf && ocf > 0) {
    add('Debt-to-CFO', ltDebt / ocf, 'Long-Term Debt / Operating Cash Flow', 'Years of operating cash flow needed to repay long-term debt');
  }

  if (revenue && capex) {
    add('CapEx Intensity', Math.abs(capex) / revenue, 'CapEx / Revenue', 'Capital investment relative to revenue — high = capital-intensive business');
  }

  if (revenue && rd) {
    add('R&D Intensity', rd / revenue, 'R&D Expense / Revenue', 'Innovation investment as % of revenue');
  } else if (!rd) {
    missing.push('R&D Intensity (needs: ResearchAndDevelopmentExpense — re-run ingest)');
  }

  if (totalAssets && goodwill) {
    add('Goodwill Ratio', goodwill / totalAssets, 'Goodwill / Total Assets', 'Acquisition premium as % of total assets — high values signal M&A risk');
  }

  return { metrics: results, missingInputs: missing };
};

/* -------------------------------------------------------------------------- */
/*                      MANAGEMENT CREDIBILITY COMPUTATION                    */
/* -------------------------------------------------------------------------- */

const computeManagementCredibility = (earningsHistory) => {
  if (!earningsHistory || !earningsHistory.length) {
    return {
      periodsAnalyzed: 0,
      overallCredibilityScore: null,
      hedgingTrend: 'insufficient_data',
      toneProgression: 'insufficient_data',
      history: [],
    };
  }

  const history = earningsHistory.map((call) => {
    const intel = call.data_json || {};
    const text = call.transcript_text || '';
    const words = tokenizeWords(text);
    const hedgeCount = words.filter((w) => HEDGING_TERMS.includes(w)).length;
    const hedgingDensity =
      words.length > 0 ? Math.round((hedgeCount / words.length) * 10000) / 10000 : 0;

    return {
      fiscalYear: call.fiscal_year,
      fiscalQuarter: call.fiscal_quarter,
      callDate: call.call_date,
      tone: intel.tone || null,
      hedgingDensity,
      guidanceCount: (intel.guidanceChanges || []).length,
      guidanceStatements: (intel.guidanceChanges || []).slice(0, 3),
    };
  });

  const toneScore = (t) => ({ positive: 1, neutral: 0, negative: -1 }[t] ?? 0);
  const toneScores = history.map((h) => toneScore(h.tone));

  const mid = Math.max(Math.floor(history.length / 2), 1);
  const recentHedging =
    history.slice(0, mid).reduce((a, b) => a + b.hedgingDensity, 0) / mid;
  const olderHedging =
    history.slice(mid).reduce((a, b) => a + b.hedgingDensity, 0) /
    Math.max(history.length - mid, 1);

  let hedgingTrend = 'stable';
  if (recentHedging > olderHedging * 1.15) hedgingTrend = 'increasing';
  else if (recentHedging < olderHedging * 0.85) hedgingTrend = 'decreasing';

  const recentTone =
    toneScores.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const olderTone =
    toneScores.slice(mid).reduce((a, b) => a + b, 0) /
    Math.max(toneScores.length - mid, 1);

  let toneProgression = 'stable';
  if (recentTone > olderTone + 0.2) toneProgression = 'improving';
  else if (recentTone < olderTone - 0.2) toneProgression = 'deteriorating';

  const mean =
    toneScores.reduce((a, b) => a + b, 0) / Math.max(toneScores.length, 1);
  const variance =
    toneScores.reduce((v, s) => v + Math.pow(s - mean, 2), 0) /
    Math.max(toneScores.length, 1);
  const toneConsistency = Math.max(0, 1 - variance);

  const avgGuidance =
    history.reduce((a, b) => a + b.guidanceCount, 0) / history.length;
  const guidanceScore = Math.min(avgGuidance / 3, 1);
  const hedgePenalty = Math.min(recentHedging * 10, 1);

  const overallCredibilityScore =
    Math.round(
      Math.max(
        0,
        Math.min(
          1,
          toneConsistency * 0.5 + guidanceScore * 0.3 + (1 - hedgePenalty) * 0.2
        )
      ) * 100
    ) / 100;

  return {
    periodsAnalyzed: history.length,
    overallCredibilityScore,
    hedgingTrend,
    toneProgression,
    history,
  };
};

/* -------------------------------------------------------------------------- */
/*                        FILING ANOMALY DETECTION                            */
/* -------------------------------------------------------------------------- */

const detectFilingAnomalies = (currentSections, historicalSectionMaps) => {
  const flags = [];
  let anomalyScore = 0;

  const allCurrentText = Object.values(currentSections).join(' ').toLowerCase();

  // 1. Risk section length vs. historical average
  const currentRiskWords = currentSections.risk_factors
    ? tokenizeWords(currentSections.risk_factors).length
    : 0;

  const historicalRiskLengths = historicalSectionMaps
    .map((hs) => (hs.risk_factors ? tokenizeWords(hs.risk_factors).length : 0))
    .filter((n) => n > 0);

  let historicalAvgRisk = null;
  if (historicalRiskLengths.length > 0) {
    historicalAvgRisk = Math.round(
      historicalRiskLengths.reduce((a, b) => a + b, 0) / historicalRiskLengths.length
    );
    if (historicalAvgRisk > 0 && currentRiskWords > 0) {
      const pctChange = (currentRiskWords - historicalAvgRisk) / historicalAvgRisk;
      if (pctChange > 0.2) {
        flags.push({
          type: 'risk_section_expansion',
          severity: pctChange > 0.4 ? 'high' : 'medium',
          description: `Risk factors section grew ${(pctChange * 100).toFixed(0)}% vs. historical average`,
          evidence: `Current: ${currentRiskWords.toLocaleString()} words, Avg: ${historicalAvgRisk.toLocaleString()} words`,
        });
        anomalyScore += Math.min(pctChange * 0.5, 0.35);
      }
    }
  }

  // 2. Going concern / solvency language
  const goingConcernHits = GOING_CONCERN_TERMS.filter((t) =>
    allCurrentText.includes(t.toLowerCase())
  );
  if (goingConcernHits.length > 0) {
    flags.push({
      type: 'going_concern_language',
      severity: 'high',
      description: 'Filing contains going concern or solvency risk language',
      evidence: goingConcernHits.slice(0, 3).join(', '),
    });
    anomalyScore += 0.4;
  }

  // 3. Material weakness or internal control issues
  if (
    allCurrentText.includes('material weakness') ||
    allCurrentText.includes('significant deficiency')
  ) {
    flags.push({
      type: 'internal_control_weakness',
      severity: 'high',
      description: 'Filing discloses material weakness or significant deficiency in internal controls',
      evidence: allCurrentText.includes('material weakness')
        ? 'material weakness'
        : 'significant deficiency',
    });
    anomalyScore += 0.35;
  }

  // 4. Accounting policy change or restatement
  const accountingHits = ACCOUNTING_CHANGE_TERMS.filter((t) =>
    allCurrentText.includes(t.toLowerCase())
  );
  if (accountingHits.length > 0) {
    flags.push({
      type: 'accounting_policy_change',
      severity: 'medium',
      description: 'Filing mentions accounting policy changes or prior-period restatements',
      evidence: accountingHits.slice(0, 3).join(', '),
    });
    anomalyScore += 0.2;
  }

  // 5. Related party transactions
  const relatedPartyHits = RELATED_PARTY_TERMS.filter((t) =>
    allCurrentText.includes(t.toLowerCase())
  );
  if (relatedPartyHits.length > 0) {
    flags.push({
      type: 'related_party_transactions',
      severity: 'low',
      description: 'Filing contains related party transaction disclosures',
      evidence: relatedPartyHits.slice(0, 3).join(', '),
    });
    anomalyScore += 0.1;
  }

  return {
    anomalyScore: Math.round(Math.min(anomalyScore, 1) * 100) / 100,
    flags,
    baseline: {
      currentRiskSectionWords: currentRiskWords,
      historicalAvgRiskSectionWords: historicalAvgRisk,
      historicalPeriodsUsed: historicalRiskLengths.length,
    },
  };
};

/* -------------------------------------------------------------------------- */
/*                          EARNINGS Q&A ANALYSIS                             */
/* -------------------------------------------------------------------------- */

const analyzeEarningsQa = (transcriptText) => {
  if (!transcriptText) return null;

  // Find the Q&A section start via common markers
  const qaPattern =
    /(?:question[s]?\s*and\s*answer|q\s*(?:&|and)\s*a\b|open.*(?:the\s*)?(?:floor|line)s?\s*(?:to|for)\s*question|begin.*question[s]?\s*(?:and\s*answer)?|operator[:\s].*(?:question|q&a))/i;
  const qaMatch = transcriptText.match(qaPattern);

  // Fall back to the last 40% of the transcript if no explicit marker found
  const qaStartIndex = qaMatch
    ? transcriptText.indexOf(qaMatch[0])
    : Math.floor(transcriptText.length * 0.6);

  const preamble = transcriptText.slice(0, qaStartIndex);
  const qaSection = transcriptText.slice(qaStartIndex);

  // Parse into speaker turns — lines starting with ALL-CAPS NAME: pattern
  const turns = [];
  const lines = qaSection.split('\n');
  let currentSpeaker = null;
  let currentLines = [];

  for (const line of lines) {
    const speakerMatch = line.match(/^([A-Z][A-Z\s,.'-]{2,60})(?:\s*\([^)]*\))?\s*:\s*(.*)/);
    if (speakerMatch) {
      if (currentSpeaker && currentLines.length) {
        turns.push({ speaker: currentSpeaker.trim(), text: currentLines.join(' ').trim() });
      }
      currentSpeaker = speakerMatch[1].trim();
      currentLines = speakerMatch[2] ? [speakerMatch[2]] : [];
    } else if (currentSpeaker && line.trim()) {
      currentLines.push(line.trim());
    }
  }
  if (currentSpeaker && currentLines.length) {
    turns.push({ speaker: currentSpeaker.trim(), text: currentLines.join(' ').trim() });
  }

  // Classify turns: management = known executive titles; analysts = ask questions
  const mgmtPattern =
    /\b(?:ceo|cfo|coo|cto|president|officer|chairman|chief|vice|svp|evp|secretary|director)\b/i;

  const analystTurns = turns.filter(
    (t) => !mgmtPattern.test(t.speaker) && t.text.includes('?') && t.text.length > 30
  );

  // Build Q&A excerpts with deflection scoring
  const qaExcerpts = [];
  for (let i = 0; i < analystTurns.length && qaExcerpts.length < 8; i++) {
    const qTurn = analystTurns[i];
    const qIndex = turns.indexOf(qTurn);

    // Find the next management response after this question
    const nextMgmt = turns
      .slice(qIndex + 1)
      .find(
        (t) =>
          mgmtPattern.test(t.speaker) ||
          (!t.text.includes('?') && t.text.length > 40)
      );

    let deflected = false;
    if (nextMgmt && qTurn.text.length > 50) {
      const qWords = tokenizeWords(qTurn.text).filter((w) => w.length > 4);
      const rWords = new Set(tokenizeWords(nextMgmt.text));
      const overlap = qWords.filter((w) => rWords.has(w)).length;
      deflected = overlap < 3 && qWords.length > 5;
    }

    qaExcerpts.push({
      speaker: qTurn.speaker,
      question: qTurn.text.slice(0, 250),
      response: nextMgmt?.text.slice(0, 250) || null,
      deflected,
    });
  }

  // Analyst concern themes — most frequent meaningful words across all questions
  const stopwords = new Set([
    'question', 'could', 'would', 'please', 'there', 'thank', 'about',
    'think', 'maybe', 'really', 'little', 'color', 'update', 'sense',
    'wonder', 'wanted', 'asking', 'heard',
  ]);
  const questionWords = analystTurns
    .flatMap((t) => tokenizeWords(t.text))
    .filter((w) => w.length > 4 && !stopwords.has(w));

  const wordFreq = {};
  for (const w of questionWords) wordFreq[w] = (wordFreq[w] || 0) + 1;

  const analystThemes = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  // First-time mentions: capitalized phrases in Q&A that don't appear in prepared remarks
  const firstTimeMentions = [
    ...new Set(
      [...qaSection.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)]
        .map((m) => m[1])
        .filter((phrase) => phrase.length > 6 && !preamble.includes(phrase))
    ),
  ].slice(0, 10);

  const deflectedCount = qaExcerpts.filter((q) => q.deflected).length;

  return {
    totalQuestions: analystTurns.length,
    deflectionRate:
      analystTurns.length
        ? Math.round((deflectedCount / analystTurns.length) * 100) / 100
        : 0,
    analystThemes,
    deflectedTopics: qaExcerpts
      .filter((q) => q.deflected)
      .map((q) => q.question.slice(0, 120)),
    firstTimeMentions,
    qaExcerpts,
  };
};

/* -------------------------------------------------------------------------- */
/*                           EXISTING HANDLERS                                */
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
/*                          NEW MOAT TOOL HANDLERS                            */
/* -------------------------------------------------------------------------- */

const handleCrossCompanyScan = async (args, logger) => {
  const { query, tickers, sectionType, limit, lookbackDays, minScore } = args || {};

  try {
    const embedding = await embedText(query);
    const fetchLimit = Math.min(Number(limit) || 20, 60) * 3;

    const rows = await searchChunksCrossCompany({
      embedding,
      tickers: Array.isArray(tickers) ? tickers.map((t) => t.toUpperCase()) : [],
      sectionType: sectionType || null,
      minScore: minScore ?? 0.3,
      limit: fetchLimit,
      lookbackDays: lookbackDays || null,
    });

    // Group by company, keep best match score at top
    const byCompany = new Map();
    for (const row of rows) {
      const key = row.cik;
      if (!byCompany.has(key)) {
        byCompany.set(key, {
          cik: row.cik,
          ticker: row.ticker || null,
          topScore: Number(row.score),
          matches: [],
        });
      }
      const entry = byCompany.get(key);
      if (Number(row.score) > entry.topScore) entry.topScore = Number(row.score);
      entry.matches.push({
        filingDate: row.filing_date,
        formType: row.form_type,
        sectionType: row.section_type,
        score: Number(row.score),
        snippet: row.text.slice(0, 300),
      });
    }

    const companies = Array.from(byCompany.values())
      .sort((a, b) => b.topScore - a.topScore)
      .slice(0, Number(limit) || 20);

    return jsonResponse(logger, {
      query,
      companiesFound: companies.length,
      companies,
    });
  } catch (error) {
    logger?.error('sec_cross_company_scan failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleDerivedMetrics = async (args, logger) => {
  const { ticker, cik } = args || {};

  try {
    const company = await resolveCompany({ ticker, cik });
    const filing = await getLatestFiling(company.cik, null);

    if (!filing) throw new Error('No filings found for company');

    const facts = await buildFactsForFiling(company.cik, filing);
    const previous = await getPreviousFiling(
      company.cik,
      filing.form_type,
      filing.filing_date
    );
    const previousFacts = previous
      ? await buildFactsForFiling(company.cik, previous)
      : [];

    const { metrics, missingInputs } = computeDerivedMetrics(facts, previousFacts);

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      filingDate: filing.filing_date,
      reportPeriod: filing.report_period,
      derivedMetrics: metrics,
      missingInputs,
    });
  } catch (error) {
    logger?.error('sec_derived_metrics failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleManagementCredibility = async (args, logger) => {
  const { ticker, cik, periods } = args || {};
  const maxPeriods = Math.min(Math.max(Number(periods) || 8, 1), 20);

  try {
    const company = await resolveCompany({ ticker, cik });
    const earningsHistory = await getAllEarningsIntel(company.cik, maxPeriods);
    const result = computeManagementCredibility(earningsHistory);

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      ...result,
    });
  } catch (error) {
    logger?.error('sec_management_credibility failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleFilingAnomaly = async (args, logger) => {
  const { ticker, cik } = args || {};

  try {
    const company = await resolveCompany({ ticker, cik });
    const current = await getLatestFiling(company.cik, null);

    if (!current) throw new Error('No filings found for company');

    const currentSections = await buildSectionMapForFiling(current);

    // Get last 4 comparable filings for baseline (excluding current)
    const history = await getFilingHistory(company.cik, current.form_type, 5);
    const historicalFilings = history
      .filter((f) => f.id !== current.id)
      .slice(0, 4);

    const historicalSectionMaps = await Promise.all(
      historicalFilings.map((f) => buildSectionMapForFiling(f))
    );

    const anomalyResult = detectFilingAnomalies(currentSections, historicalSectionMaps);

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      filingDate: current.filing_date,
      formType: current.form_type,
      reportPeriod: current.report_period,
      ...anomalyResult,
    });
  } catch (error) {
    logger?.error('sec_filing_anomaly failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleEarningsQa = async (args, logger) => {
  const { ticker, cik, year, quarter } = args || {};

  try {
    const company = await resolveCompany({ ticker, cik });
    const call = await getEarningsCall({
      cik: company.cik,
      fiscalYear: year || null,
      fiscalQuarter: quarter || null,
    });

    if (!call) {
      return jsonResponse(logger, {
        cik: company.cik,
        ticker: company.ticker || null,
        callDate: null,
        totalQuestions: 0,
        deflectionRate: 0,
        analystThemes: [],
        deflectedTopics: [],
        firstTimeMentions: [],
        qaExcerpts: [],
        status: 'no_transcript_found',
      });
    }

    const qa = analyzeEarningsQa(call.transcript_text);

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      callDate: call.call_date,
      fiscalYear: call.fiscal_year,
      fiscalQuarter: call.fiscal_quarter,
      ...(qa || {
        totalQuestions: 0,
        deflectionRate: 0,
        analystThemes: [],
        deflectedTopics: [],
        firstTimeMentions: [],
        qaExcerpts: [],
      }),
    });
  } catch (error) {
    logger?.error('sec_earnings_qa failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleLongitudinalTone = async (args, logger) => {
  const { ticker, cik, periods } = args || {};
  const maxPeriods = Math.min(Math.max(Number(periods) || 8, 1), 20);

  try {
    const company = await resolveCompany({ ticker, cik });
    const earningsHistory = await getAllEarningsIntel(company.cik, maxPeriods);

    const periodData = earningsHistory.map((call) => {
      const intel = call.data_json || {};
      const text = call.transcript_text || '';
      const words = tokenizeWords(text);
      const hedgeCount = words.filter((w) => HEDGING_TERMS.includes(w)).length;
      const hedgingDensity =
        words.length > 0
          ? Math.round((hedgeCount / words.length) * 10000) / 10000
          : 0;

      return {
        fiscalYear: call.fiscal_year,
        fiscalQuarter: call.fiscal_quarter,
        callDate: call.call_date,
        earningsTone: intel.tone || null,
        guidanceCount: (intel.guidanceChanges || []).length,
        hedgingDensity,
      };
    });

    const toneScore = (t) => ({ positive: 1, neutral: 0, negative: -1 }[t] ?? 0);
    const tones = periodData
      .filter((p) => p.earningsTone)
      .map((p) => toneScore(p.earningsTone));

    let trendSummary = 'Insufficient earnings call data for trend analysis.';

    if (tones.length >= 2) {
      const mid = Math.ceil(tones.length / 2);
      const recentAvg = tones.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const olderAvg =
        tones.slice(mid).reduce((a, b) => a + b, 0) /
        Math.max(tones.length - mid, 1);

      if (recentAvg > olderAvg + 0.2) {
        trendSummary = 'Earnings tone has been improving in recent quarters.';
      } else if (recentAvg < olderAvg - 0.2) {
        trendSummary = 'Earnings tone has been declining in recent quarters.';
      } else {
        trendSummary = 'Earnings tone has been stable across analyzed periods.';
      }

      const hedgeValues = periodData.map((p) => p.hedgingDensity);
      const recentHedge =
        hedgeValues.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const olderHedge =
        hedgeValues.slice(mid).reduce((a, b) => a + b, 0) /
        Math.max(hedgeValues.length - mid, 1);

      if (recentHedge > olderHedge * 1.2) {
        trendSummary +=
          ' Hedging language has been increasing — management may be less confident.';
      } else if (recentHedge < olderHedge * 0.8) {
        trendSummary +=
          ' Hedging language has decreased — management is speaking more directly.';
      }
    }

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      periodsAnalyzed: periodData.length,
      periods: periodData,
      trendSummary,
    });
  } catch (error) {
    logger?.error('sec_longitudinal_tone failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleSectorDrift = async (args, logger) => {
  const { term, tickers, lookbackDays, limit } = args || {};
  const windowDays = Number(lookbackDays) || 90;
  const resultLimit = Number(limit) || 30;

  try {
    // Recent mentions: filings filed within the lookback window
    const recentRows = await searchTextInChunks({
      term,
      tickers: Array.isArray(tickers) ? tickers.map((t) => t.toUpperCase()) : [],
      limit: resultLimit,
      lookbackDays: windowDays,
    });

    // All historical mentions (no date filter) — used to compute baseline
    const allRows = await searchTextInChunks({
      term,
      tickers: Array.isArray(tickers) ? tickers.map((t) => t.toUpperCase()) : [],
      limit: 300,
      lookbackDays: null,
    });

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);

    // Companies with recent-only mentions vs. historically present companies
    const recentCiks = new Set(recentRows.map((r) => r.cik));
    const historicalCiks = new Set(
      allRows
        .filter((r) => new Date(r.filing_date) < cutoffDate)
        .map((r) => r.cik)
    );

    const recentMentions = recentCiks.size;
    const historicalMentions = historicalCiks.size;

    const driftScore =
      historicalMentions > 0
        ? Math.round((recentMentions / historicalMentions) * 100) / 100
        : recentMentions > 0
          ? null // emerged from zero — ratio undefined
          : 0;

    // Deduplicated list of companies with recent mentions
    const seenCiks = new Set();
    const emergingCompanies = recentRows
      .filter((r) => {
        if (seenCiks.has(r.cik)) return false;
        seenCiks.add(r.cik);
        return true;
      })
      .map((r) => ({
        cik: r.cik,
        ticker: r.ticker || null,
        filingDate: r.filing_date,
        formType: r.form_type,
        sectionType: r.section_type,
        snippet: r.text.slice(0, 300),
      }));

    return jsonResponse(logger, {
      term,
      lookbackDays: windowDays,
      recentMentions,
      historicalMentions,
      driftScore,
      emergingCompanies,
    });
  } catch (error) {
    logger?.error('sec_sector_drift failed', { error: error?.message });
    return errorResponse(logger, error?.message || 'Unknown error');
  }
};

const handleCompanyMentions = async (args, logger) => {
  const { ticker, cik, sectionTypes } = args || {};
  const targetSections =
    Array.isArray(sectionTypes) && sectionTypes.length
      ? sectionTypes
      : ['business', 'mdna'];

  try {
    const company = await resolveCompany({ ticker, cik });
    const filing = await getLatestFiling(company.cik, null);

    if (!filing) throw new Error('No filings found for company');

    const sectionMap = await buildSectionMapForFiling(filing);
    const searchText = targetSections.map((s) => sectionMap[s] || '').join(' ');

    if (!searchText.trim()) {
      return jsonResponse(logger, {
        cik: company.cik,
        ticker: company.ticker || null,
        filingDate: filing.filing_date,
        mentionsFound: 0,
        mentions: [],
        relationshipSentences: [],
      });
    }

    const allCompanies = await listCompanies();
    const mentions = [];

    for (const other of allCompanies) {
      if (other.cik === company.cik) continue;
      if (!other.name || other.name.length < 4) continue;

      // Truncate very long names to avoid spurious partial matches
      const searchName =
        other.name.length > 50 ? other.name.slice(0, 50) : other.name;

      if (!searchText.includes(searchName)) continue;

      const sentences = splitSentences(searchText)
        .filter((s) => s.includes(searchName))
        .slice(0, 3);

      if (!sentences.length) continue;

      const context = sentences.join(' ').toLowerCase();
      const relationshipKeywords = [];

      if (/supplier|manufactur|vendor|source(?:d|s| from)/.test(context)) {
        relationshipKeywords.push('supplier');
      }
      if (/customer|buyer|purchas|client/.test(context)) {
        relationshipKeywords.push('customer');
      }
      if (/partner|collaborat|alliance|joint venture/.test(context)) {
        relationshipKeywords.push('partner');
      }
      if (/compet|rival/.test(context)) {
        relationshipKeywords.push('competitor');
      }
      if (/licens|patent|intellectual property/.test(context)) {
        relationshipKeywords.push('licensor/licensee');
      }

      mentions.push({
        mentionedTicker: other.ticker || null,
        mentionedName: other.name,
        relationshipKeywords,
        sentences: sentences.map((s) => s.slice(0, 300)),
      });
    }

    // Generic relationship sentences not tied to a specific named company
    const relationshipPattern =
      /(?:our largest|our primary|our main|we rely on|third[- ]party|service provider|strategic partner|joint venture|distribution agreement|concentration risk|customer concentration|sole supplier)/i;

    const relationshipSentences = splitSentences(searchText)
      .filter((s) => relationshipPattern.test(s))
      .slice(0, 12)
      .map((s) => {
        let type = 'general';
        const sl = s.toLowerCase();
        if (/supplier|vendor|manufactur/.test(sl)) type = 'supplier';
        else if (/customer|buyer|client|concentration/.test(sl)) type = 'customer';
        else if (/partner|joint venture|alliance/.test(sl)) type = 'partner';
        else if (/compet/.test(sl)) type = 'competitor';
        return { relationshipType: type, sentence: s.slice(0, 320) };
      });

    return jsonResponse(logger, {
      cik: company.cik,
      ticker: company.ticker || null,
      filingDate: filing.filing_date,
      mentionsFound: mentions.length,
      mentions: mentions.slice(0, 25),
      relationshipSentences,
    });
  } catch (error) {
    logger?.error('sec_company_mentions failed', { error: error?.message });
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

      case 'sec_cross_company_scan':
        return handleCrossCompanyScan(args, baseLogger);

      case 'sec_derived_metrics':
        return handleDerivedMetrics(args, baseLogger);

      case 'sec_management_credibility':
        return handleManagementCredibility(args, baseLogger);

      case 'sec_filing_anomaly':
        return handleFilingAnomaly(args, baseLogger);

      case 'sec_earnings_qa':
        return handleEarningsQa(args, baseLogger);

      case 'sec_longitudinal_tone':
        return handleLongitudinalTone(args, baseLogger);

      case 'sec_sector_drift':
        return handleSectorDrift(args, baseLogger);

      case 'sec_company_mentions':
        return handleCompanyMentions(args, baseLogger);

      default:
        return errorResponse(baseLogger, `Unknown tool: ${name}`);
    }
  });

  return server;
};
