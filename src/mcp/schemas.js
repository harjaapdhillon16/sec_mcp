import * as z from 'zod/v4';

export const LatestIntelInputSchema = {
  ticker: z.string().optional().describe('Ticker symbol (e.g., AAPL)'),
  cik: z.string().optional().describe('CIK (10-digit)') ,
  formType: z.enum(['10-K', '10-Q', '8-K']).optional().describe('Filing form type'),
  includeSections: z.boolean().optional().default(false)
};

export const MetricSchema = z.object({
  tag: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
  periodEnd: z.string().nullable(),
  fy: z.number().nullable(),
  fp: z.string().nullable()
});

export const LatestIntelOutputSchema = z.object({
  cik: z.string(),
  ticker: z.string().nullable(),
  formType: z.string(),
  filingDate: z.string(),
  reportPeriod: z.string().nullable(),
  primaryDocUrl: z.string().nullable(),
  keyMetrics: z.array(MetricSchema),
  takeaways: z.array(z.string()),
  riskSummary: z.object({
    summary: z.string(),
    highlights: z.array(z.string()),
    sentimentScore: z.number().nullable()
  }),
  signals: z.array(z.string()),
  sections: z.array(z.object({
    sectionType: z.string(),
    summary: z.string(),
    length: z.number()
  }))
});

export const CompareInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  formType: z.enum(['10-K', '10-Q']).optional()
};

export const CompareOutputSchema = z.object({
  cik: z.string(),
  ticker: z.string().nullable(),
  current: z.object({
    filingId: z.string(),
    formType: z.string(),
    filingDate: z.string(),
    reportPeriod: z.string().nullable()
  }),
  previous: z.object({
    filingId: z.string(),
    formType: z.string(),
    filingDate: z.string(),
    reportPeriod: z.string().nullable()
  }),
  metricDeltas: z.array(z.object({
    tag: z.string(),
    label: z.string(),
    unit: z.string().nullable(),
    currentValue: z.number(),
    previousValue: z.number(),
    delta: z.number(),
    deltaPct: z.number().nullable()
  })),
  narrativeChanges: z.array(z.object({
    sectionType: z.string(),
    newItems: z.array(z.string()),
    removedItems: z.array(z.string()),
    intensifiedItems: z.array(z.string()),
    citations: z.array(z.string())
  })),
  summary: z.string()
});

export const SemanticSearchInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  query: z.string().describe('Search query'),
  sectionType: z.string().optional(),
  limit: z.number().optional().default(6)
};

export const SemanticSearchOutputSchema = z.object({
  cik: z.string(),
  ticker: z.string().nullable(),
  query: z.string(),
  matches: z.array(z.object({
    chunkId: z.string(),
    filingId: z.string(),
    filingDate: z.string(),
    formType: z.string(),
    sectionType: z.string(),
    score: z.number(),
    snippet: z.string()
  }))
});

export const EarningsInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  year: z.number().optional(),
  quarter: z.number().optional()
};

export const EarningsOutputSchema = z.object({
  cik: z.string(),
  ticker: z.string().nullable(),
  status: z.enum(['ok', 'not_configured', 'not_found']),
  callDate: z.string().nullable(),
  summary: z.string().nullable(),
  tone: z.string().nullable(),
  guidanceChanges: z.array(z.string()),
  keyQuotes: z.array(z.string())
});
