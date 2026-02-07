import * as z from 'zod/v4';

export const ErrorOutputSchema = z.object({
  status: z.literal('error'),
  error: z.object({
    message: z.string(),
    code: z.string().nullable().optional(),
    details: z.string().nullable().optional()
  })
});

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

const LatestIntelSuccessSchema = z.object({
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
export const LatestIntelOutputSchema = z.union([LatestIntelSuccessSchema, ErrorOutputSchema]);

export const CompareInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  formType: z.enum(['10-K', '10-Q']).optional()
};

const CompareSuccessSchema = z.object({
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
export const CompareOutputSchema = z.union([CompareSuccessSchema, ErrorOutputSchema]);

export const SemanticSearchInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  query: z.string().describe('Search query'),
  sectionType: z.string().optional(),
  limit: z.number().optional().default(6)
};

const SemanticSearchSuccessSchema = z.object({
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
export const SemanticSearchOutputSchema = z.union([SemanticSearchSuccessSchema, ErrorOutputSchema]);

export const EarningsInputSchema = {
  ticker: z.string().optional(),
  cik: z.string().optional(),
  year: z.number().optional(),
  quarter: z.number().optional()
};

const EarningsSuccessSchema = z.object({
  cik: z.string(),
  ticker: z.string().nullable(),
  status: z.enum(['ok', 'not_configured', 'not_found']),
  callDate: z.string().nullable(),
  summary: z.string().nullable(),
  tone: z.string().nullable(),
  guidanceChanges: z.array(z.string()),
  keyQuotes: z.array(z.string())
});
export const EarningsOutputSchema = z.union([EarningsSuccessSchema, ErrorOutputSchema]);
