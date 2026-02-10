import { DEFAULT_SECTIONS, KEY_TAGS, NEGATIVE_TERMS, POSITIVE_TERMS } from './constants.js';
import { clamp, percentChange, splitSentences, tokenizeWords } from './utils.js';

const tagLabel = (tag) => {
  const match = KEY_TAGS.find(item => item.tag === tag);
  return match ? match.label : tag;
};

export const computeMetricDeltas = (currentFacts, previousFacts) => {
  const prevMap = new Map(previousFacts.map(f => [f.tag, f]));
  const deltas = [];
  for (const fact of currentFacts) {
    const prev = prevMap.get(fact.tag);
    if (!prev || prev.value === null || prev.value === undefined) continue;
    const delta = fact.value - prev.value;
    const deltaPct = percentChange(fact.value, prev.value);
    deltas.push({
      tag: fact.tag,
      label: tagLabel(fact.tag),
      unit: fact.unit,
      currentValue: fact.value,
      previousValue: prev.value,
      delta,
      deltaPct
    });
  }
  return deltas;
};

const sentimentScore = (text) => {
  const words = tokenizeWords(text);
  if (!words.length) return 0;
  const neg = words.filter(w => NEGATIVE_TERMS.includes(w)).length;
  const pos = words.filter(w => POSITIVE_TERMS.includes(w)).length;
  const raw = (pos - neg) / words.length;
  return clamp(raw * 5, -1, 1);
};

const extractHighlights = (text) => {
  const sentences = splitSentences(text);
  if (!sentences.length) return [];
  const scored = sentences.map(sentence => {
    const words = tokenizeWords(sentence);
    const neg = words.filter(w => NEGATIVE_TERMS.includes(w)).length;
    const pos = words.filter(w => POSITIVE_TERMS.includes(w)).length;
    return { sentence, score: neg - pos };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(item => item.sentence);
};

export const buildRiskSummary = (text) => {
  if (!text) {
    return {
      summary: 'No risk factors section available.',
      highlights: [],
      sentimentScore: 0
    };
  }
  const highlights = extractHighlights(text);
  const score = sentimentScore(text);
  const summary = highlights.length
    ? `Risk factors emphasize ${highlights[0].slice(0, 140)}...`
    : 'Risk factors section present but no standout highlights detected.';
  return {
    summary,
    highlights,
    sentimentScore: score
  };
};

export const buildLatestIntel = ({ company, filing, sections, facts, previousFacts }) => {
  const metrics = facts.map(fact => ({
    tag: fact.tag,
    label: tagLabel(fact.tag),
    value: fact.value,
    unit: fact.unit,
    periodEnd: fact.end_date,
    fy: fact.fy,
    fp: fact.fp
  }));
  const deltas = computeMetricDeltas(facts, previousFacts);
  const topDelta = deltas.sort((a, b) => Math.abs(b.deltaPct || 0) - Math.abs(a.deltaPct || 0))[0];
  const takeaways = [];
  if (topDelta && topDelta.deltaPct !== null) {
    const pct = (topDelta.deltaPct * 100).toFixed(1);
    takeaways.push(`${topDelta.label} changed ${pct}% versus prior period.`);
  }
  if (sections.risk_factors) {
    const wordCount = tokenizeWords(sections.risk_factors).length;
    takeaways.push(`Risk factors section is ~${wordCount.toLocaleString()} words.`);
  }
  if (sections.mdna) {
    takeaways.push('MD&A section available for narrative analysis.');
  }
  const riskSummary = buildRiskSummary(sections.risk_factors || '');
  const signals = [];
  if (topDelta && topDelta.deltaPct !== null) {
    signals.push(`Watch ${topDelta.label} movement (${(topDelta.deltaPct * 100).toFixed(1)}%).`);
  }
  if (riskSummary.sentimentScore < -0.2) {
    signals.push('Risk tone skewed negative vs. baseline.');
  }
  const sectionSummaries = Object.entries(sections)
    .filter(([key]) => DEFAULT_SECTIONS.includes(key))
    .map(([key, value]) => ({
      sectionType: key,
      summary: value.slice(0, 200),
      length: tokenizeWords(value).length
    }));
  return {
    cik: company.cik,
    ticker: company.ticker || null,
    formType: filing.form_type,
    filingDate: filing.filing_date,
    reportPeriod: filing.report_period,
    primaryDocUrl: filing.primary_doc_url,
    keyMetrics: metrics,
    takeaways,
    riskSummary,
    signals,
    sections: sectionSummaries
  };
};

export const buildComparisonIntel = ({
  company,
  currentFiling,
  previousFiling,
  metricDeltas,
  narrativeChanges
}) => {
  const summaryParts = [];
  if (metricDeltas.length) {
    const top = metricDeltas[0];
    if (top.deltaPct !== null) {
      summaryParts.push(`${top.label} moved ${(top.deltaPct * 100).toFixed(1)}% vs prior period.`);
    }
  }
  if (narrativeChanges.length) {
    summaryParts.push('Narrative changes detected in key sections.');
  }
  return {
    cik: company.cik,
    ticker: company.ticker || null,
    current: {
      filingId: currentFiling.id,
      formType: currentFiling.form_type,
      filingDate: currentFiling.filing_date,
      reportPeriod: currentFiling.report_period
    },
    previous: {
      filingId: previousFiling.id,
      formType: previousFiling.form_type,
      filingDate: previousFiling.filing_date,
      reportPeriod: previousFiling.report_period
    },
    metricDeltas,
    narrativeChanges,
    summary: summaryParts.join(' ')
  };
};
