import { config } from '../config.js';
import { getCompanyByCik, getCompanyByTicker } from '../db/queries.js';
import { getCompanyTickerMap, getSubmissions, getCompanyFacts, fetchFilingDocument, buildPrimaryDocUrl } from './sec.js';
import { htmlToText, extractSections } from './filingParser.js';
import { buildLatestIntel, buildRiskSummary } from './intel.js';
import { KEY_TAGS, DEFAULT_SECTIONS } from './constants.js';
import { normalizeCik, normalizeTicker, estimateTokens, clamp, cleanText } from './utils.js';
import { searchWeb, fetchPageText, trimToTokens } from './webSearch.js';
import { streamChatCompletion } from './llm.js';

const tagLabel = (tag) => {
  const match = KEY_TAGS.find(item => item.tag === tag);
  return match ? match.label : tag;
};

const safeStream = (streamLog, message) => {
  if (!streamLog) return;
  try {
    streamLog(message);
  } catch {
    // ignore stream errors
  }
};

const resolveCompanyFromDb = async ({ ticker, cik }) => {
  const normalizedTicker = normalizeTicker(ticker);
  const normalizedCik = normalizeCik(cik);
  try {
    if (normalizedCik) {
      const company = await getCompanyByCik(normalizedCik);
      if (company) return company;
    }
    if (normalizedTicker) {
      const company = await getCompanyByTicker(normalizedTicker);
      if (company) return company;
    }
  } catch {
    // ignore lookup errors
  }
  return null;
};

const resolveCompanyIdentity = async ({ ticker, cik }) => {
  const normalizedTicker = normalizeTicker(ticker);
  const normalizedCik = normalizeCik(cik);
  const companyFromDb = await resolveCompanyFromDb({ ticker: normalizedTicker, cik: normalizedCik });
  if (companyFromDb) {
    return {
      cik: companyFromDb.cik,
      ticker: companyFromDb.ticker || normalizedTicker,
      name: companyFromDb.name || null
    };
  }
  if (normalizedCik) {
    return { cik: normalizedCik, ticker: normalizedTicker, name: null };
  }
  if (!normalizedTicker) {
    throw new Error('Provide ticker or CIK');
  }
  const map = await getCompanyTickerMap();
  const entries = Object.values(map || {});
  const match = entries.find(entry => String(entry.ticker || '').toUpperCase() === normalizedTicker);
  if (!match) {
    throw new Error(`Ticker ${normalizedTicker} not found in SEC mapping`);
  }
  return {
    cik: normalizeCik(String(match.cik_str)),
    ticker: normalizedTicker,
    name: match.title || null
  };
};

const pickLatestFiling = (recent, formFilter) => {
  if (!recent?.accessionNumber?.length) return null;
  const allowed = new Set(formFilter);
  let best = null;
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const form = recent.form?.[i];
    if (!allowed.has(form)) continue;
    const filingDate = recent.filingDate?.[i] || '';
    if (!best || filingDate > best.filingDate) {
      best = {
        accession: recent.accessionNumber[i],
        formType: form,
        filingDate,
        reportDate: recent.reportDate?.[i] || null,
        primaryDocument: recent.primaryDocument?.[i] || null
      };
    }
  }
  return best;
};

const buildFactsFromCompanyFacts = (factsJson) => {
  const usGaap = factsJson?.facts?.['us-gaap'] || {};
  const facts = [];
  const previousFacts = [];
  for (const { tag } of KEY_TAGS) {
    const tagData = usGaap[tag];
    if (!tagData?.units) continue;
    const items = [];
    for (const [unit, values] of Object.entries(tagData.units)) {
      for (const item of values || []) {
        const value = typeof item.val === 'number' ? item.val : Number(item.val);
        if (!Number.isFinite(value) || !item.end) continue;
        items.push({
          unit,
          value,
          end: item.end,
          start: item.start || null,
          fy: item.fy || null,
          fp: item.fp || null
        });
      }
    }
    if (!items.length) continue;
    items.sort((a, b) => (a.end < b.end ? 1 : -1));
    const latest = items[0];
    facts.push({
      tag,
      unit: latest.unit,
      value: latest.value,
      end_date: latest.end,
      start_date: latest.start,
      fy: latest.fy,
      fp: latest.fp
    });
    const prev = items[1];
    if (prev) {
      previousFacts.push({
        tag,
        unit: prev.unit,
        value: prev.value,
        end_date: prev.end,
        start_date: prev.start,
        fy: prev.fy,
        fp: prev.fp
      });
    }
  }
  return { facts, previousFacts };
};

const sanitizeStringArray = (values, maxItems) => {
  if (!Array.isArray(values)) return [];
  return values
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems);
};

const sanitizeRiskSummary = (value, fallbackText) => {
  const fallback = buildRiskSummary(fallbackText || '');
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  const summary = typeof value.summary === 'string' && value.summary.trim()
    ? value.summary.trim()
    : fallback.summary;
  const highlights = sanitizeStringArray(value.highlights, 3);
  const sentimentScore = typeof value.sentimentScore === 'number'
    ? clamp(value.sentimentScore, -1, 1)
    : fallback.sentimentScore;
  return {
    summary,
    highlights: highlights.length ? highlights : fallback.highlights,
    sentimentScore
  };
};

const safeJsonParse = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const buildPrompt = ({
  company,
  filing,
  facts,
  sections,
  webPages,
  maxTokens
}) => {
  const metrics = facts.map(fact => {
    const label = tagLabel(fact.tag);
    const unit = fact.unit || '';
    const period = fact.end_date || 'n/a';
    return `${label} (${fact.tag}): ${fact.value} ${unit} (period end ${period})`;
  }).join('\n');

  const maxSectionTokens = Math.max(200, Math.floor(maxTokens * 0.12));
  const sectionBlocks = DEFAULT_SECTIONS.map((sectionType) => {
    const raw = sections?.[sectionType];
    if (!raw) return null;
    const trimmed = trimToTokens(cleanText(raw), maxSectionTokens);
    if (!trimmed) return null;
    return `Section ${sectionType}:\n${trimmed}`;
  }).filter(Boolean).join('\n\n');

  const maxPageTokens = Math.max(200, Math.floor(maxTokens * 0.1));
  const webBlocks = (webPages || []).map((page) => {
    const snippet = page.snippet ? trimToTokens(page.snippet, 120) : '';
    const text = page.text ? trimToTokens(page.text, maxPageTokens) : '';
    return `Source: ${page.url}\nTitle: ${page.title || ''}\nSnippet: ${snippet}\nExcerpt: ${text}`;
  }).join('\n\n');

  const body = [
    `Company: ${company.name || 'Unknown'} (${company.ticker || 'n/a'}, CIK ${company.cik})`,
    `Filing: ${filing.form_type} filed ${filing.filing_date || 'n/a'} (report period ${filing.report_period || 'n/a'})`,
    `Primary document: ${filing.primary_doc_url || 'n/a'}`,
    '',
    'Key metrics:',
    metrics || 'No metrics available.',
    '',
    'Filing sections:',
    sectionBlocks || 'No section excerpts available.',
    '',
    'Web excerpts:',
    webBlocks || 'No web excerpts available.'
  ].join('\n');

  return body;
};

const buildSystemPrompt = () => (
  [
    'You are a financial analyst.',
    'Return ONLY valid JSON (no markdown, no code fences).',
    'JSON shape:',
    '{',
    '  \"takeaways\": [\"string\"],',
    '  \"signals\": [\"string\"],',
    '  \"riskSummary\": {',
    '    \"summary\": \"string\",',
    '    \"highlights\": [\"string\"],',
    '    \"sentimentScore\": number',
    '  }',
    '}',
    'Constraints:',
    '- takeaways max 5 items',
    '- signals max 5 items',
    '- highlights max 3 items',
    '- sentimentScore between -1 and 1',
    'Be concise and avoid speculation.'
  ].join('\n')
);

const enrichWithLlm = async ({
  baseIntel,
  company,
  filing,
  facts,
  sections,
  webPages,
  streamLog
}) => {
  if (config.llmProvider !== 'openai' || !config.openaiApiKey) {
    safeStream(streamLog, '[fallback] LLM not configured, using heuristic output.\n');
    return baseIntel;
  }
  const maxTokens = config.llmMaxInputTokens || 6000;
  const system = buildSystemPrompt();
  const user = buildPrompt({ company, filing, facts, sections, webPages, maxTokens });

  if (estimateTokens(user) > maxTokens) {
    // continue; prompt will be trimmed downstream if needed
  }

  safeStream(streamLog, '[fallback] Generating summary via LLM...\n');
  let raw = null;
  try {
    raw = await streamChatCompletion({
      system,
      user,
      maxTokens: Math.min(900, Math.max(400, Math.floor(maxTokens / 6))),
      onDelta: (delta) => safeStream(streamLog, delta)
    });
  } catch (error) {
    safeStream(streamLog, '\n[fallback] LLM summarization failed, using heuristic output.\n');
    return baseIntel;
  }
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    safeStream(streamLog, '\n[fallback] Invalid LLM JSON output, using heuristic output.\n');
    return baseIntel;
  }
  const takeaways = sanitizeStringArray(parsed.takeaways, 5);
  const signals = sanitizeStringArray(parsed.signals, 5);
  const riskSummary = sanitizeRiskSummary(parsed.riskSummary, sections?.risk_factors || '');

  return {
    ...baseIntel,
    takeaways: takeaways.length ? takeaways : baseIntel.takeaways,
    signals: signals.length ? signals : baseIntel.signals,
    riskSummary
  };
};

export const buildLatestIntelFallback = async ({
  ticker,
  cik,
  formType,
  includeSections,
  streamLog
}) => {
  safeStream(streamLog, '[fallback] Resolving company...\n');
  const company = await resolveCompanyIdentity({ ticker, cik });
  safeStream(streamLog, '[fallback] Fetching SEC submissions...\n');
  const submissions = await getSubmissions(company.cik);
  const submissionTickers = Array.isArray(submissions?.tickers) ? submissions.tickers : [];
  const tickerResolved = company.ticker || submissionTickers[0] || null;
  const companyName = company.name || submissions?.name || null;
  const resolvedCompany = {
    cik: company.cik,
    ticker: tickerResolved,
    name: companyName
  };
  const recent = submissions?.filings?.recent;
  const formFilter = Array.isArray(formType) ? formType : (formType ? [formType] : ['10-K', '10-Q']);
  const latest = pickLatestFiling(recent, formFilter);
  if (!latest) {
    throw new Error('No filings found for company');
  }
  const primaryDocUrl = latest.primaryDocument
    ? buildPrimaryDocUrl(company.cik, latest.accession, latest.primaryDocument)
    : null;
  const filing = {
    form_type: latest.formType,
    filing_date: latest.filingDate,
    report_period: latest.reportDate,
    primary_doc_url: primaryDocUrl
  };

  let sections = {};
  if (primaryDocUrl) {
    safeStream(streamLog, '[fallback] Fetching filing document...\n');
    const html = await fetchFilingDocument(primaryDocUrl);
    const rawText = htmlToText(html);
    sections = extractSections(rawText);
  }

  safeStream(streamLog, '[fallback] Fetching company facts...\n');
  const factsJson = await getCompanyFacts(company.cik);
  const { facts, previousFacts } = buildFactsFromCompanyFacts(factsJson);

  const baseIntel = buildLatestIntel({
    company: resolvedCompany,
    filing,
    sections,
    facts,
    previousFacts
  });
  if (!includeSections) {
    baseIntel.sections = [];
  }

  safeStream(streamLog, '[fallback] Running web search...\n');
  const queryParts = [
    companyName || tickerResolved || company.cik,
    tickerResolved ? `(${tickerResolved})` : null,
    'latest',
    latest.formType,
    'filing summary'
  ].filter(Boolean);
  const query = queryParts.join(' ');
  const searchResult = await searchWeb(query, { maxResults: config.tavilyMaxResults });
  const webResults = searchResult?.results || [];
  const pagesToFetch = webResults.slice(0, Math.min(3, webResults.length));
  const pageTexts = await Promise.all(
    pagesToFetch.map(async (result) => {
      const text = await fetchPageText(result.url, { maxTokens: Math.floor((config.llmMaxInputTokens || 6000) * 0.1) });
      return {
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        text
      };
    })
  );

  const enriched = await enrichWithLlm({
    baseIntel,
    company: resolvedCompany,
    filing,
    facts,
    sections,
    webPages: pageTexts,
    streamLog
  });

  return {
    intel: enriched,
    sources: {
      submissionsUrl: `https://data.sec.gov/submissions/CIK${company.cik}.json`,
      factsUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
      primaryDocUrl
    }
  };
};
