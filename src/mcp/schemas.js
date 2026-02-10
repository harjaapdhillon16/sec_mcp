export const ErrorOutputSchema = {
  type: 'object',
  properties: {
    status: { const: 'error' },
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        code: { type: ['string', 'null'] },
        details: { type: ['string', 'null'] }
      },
      required: ['message']
    }
  },
  required: ['status', 'error']
};

export const LatestIntelInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string', description: 'Ticker symbol (e.g., AAPL)' },
    cik: { type: 'string', description: 'CIK (10-digit)' },
    formType: {
      type: 'string',
      enum: ['10-K', '10-Q', '8-K'],
      description: 'Filing form type'
    },
    includeSections: { type: 'boolean', default: false }
  }
};

export const MetricSchema = {
  type: 'object',
  properties: {
    tag: { type: 'string' },
    label: { type: 'string' },
    value: { type: 'number' },
    unit: { type: ['string', 'null'] },
    periodEnd: { type: ['string', 'null'] },
    fy: { type: ['number', 'null'] },
    fp: { type: ['string', 'null'] }
  },
  required: ['tag', 'label', 'value']
};

const LatestIntelSuccessSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    formType: { type: 'string' },
    filingDate: { type: 'string' },
    reportPeriod: { type: ['string', 'null'] },
    primaryDocUrl: { type: ['string', 'null'] },
    keyMetrics: { type: 'array', items: MetricSchema },
    takeaways: { type: 'array', items: { type: 'string' } },
    riskSummary: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        highlights: { type: 'array', items: { type: 'string' } },
        sentimentScore: {
          type: 'number',
          description: 'Sentiment score from -1 to 1 (0 when no risk factors section exists).'
        }
      },
      required: ['summary', 'highlights', 'sentimentScore']
    },
    signals: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sectionType: { type: 'string' },
          summary: { type: 'string' },
          length: { type: 'number' }
        },
        required: ['sectionType', 'summary', 'length']
      }
    }
  },
  required: [
    'cik',
    'ticker',
    'formType',
    'filingDate',
    'reportPeriod',
    'primaryDocUrl',
    'keyMetrics',
    'takeaways',
    'riskSummary',
    'signals',
    'sections'
  ]
};

export const LatestIntelOutputSchema = {
  type: 'object',
  oneOf: [LatestIntelSuccessSchema, ErrorOutputSchema]
};

export const CompareInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    formType: { type: 'string', enum: ['10-K', '10-Q'] }
  }
};

const CompareSuccessSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    current: {
      type: 'object',
      properties: {
        filingId: { type: 'string' },
        formType: { type: 'string' },
        filingDate: { type: 'string' },
        reportPeriod: { type: ['string', 'null'] }
      },
      required: ['filingId', 'formType', 'filingDate', 'reportPeriod']
    },
    previous: {
      type: 'object',
      properties: {
        filingId: { type: 'string' },
        formType: { type: 'string' },
        filingDate: { type: 'string' },
        reportPeriod: { type: ['string', 'null'] }
      },
      required: ['filingId', 'formType', 'filingDate', 'reportPeriod']
    },
    metricDeltas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          label: { type: 'string' },
          unit: { type: ['string', 'null'] },
          currentValue: { type: 'number' },
          previousValue: { type: 'number' },
          delta: { type: 'number' },
          deltaPct: { type: ['number', 'null'] }
        },
        required: [
          'tag',
          'label',
          'unit',
          'currentValue',
          'previousValue',
          'delta',
          'deltaPct'
        ]
      }
    },
    narrativeChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sectionType: { type: 'string' },
          newItems: { type: 'array', items: { type: 'string' } },
          removedItems: { type: 'array', items: { type: 'string' } },
          intensifiedItems: { type: 'array', items: { type: 'string' } },
          citations: { type: 'array', items: { type: 'string' } }
        },
        required: [
          'sectionType',
          'newItems',
          'removedItems',
          'intensifiedItems',
          'citations'
        ]
      }
    },
    summary: { type: 'string' }
  },
  required: [
    'cik',
    'ticker',
    'current',
    'previous',
    'metricDeltas',
    'narrativeChanges',
    'summary'
  ]
};

export const CompareOutputSchema = {
  type: 'object',
  oneOf: [CompareSuccessSchema, ErrorOutputSchema]
};

export const SemanticSearchInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    query: { type: 'string', description: 'Search query' },
    sectionType: { type: 'string' },
    limit: { type: 'number', default: 6 },
    minFilingDate: {
      type: 'string',
      description: 'Earliest filing date to include (YYYY-MM-DD)'
    },
    maxFilingDate: {
      type: 'string',
      description: 'Latest filing date to include (YYYY-MM-DD)'
    }
  },
  required: ['query']
};

const SemanticSearchSuccessSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    query: { type: 'string' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          chunkId: { type: 'string' },
          filingId: { type: 'string' },
          filingDate: { type: 'string' },
          formType: { type: 'string' },
          sectionType: { type: 'string' },
          score: { type: 'number' },
          snippet: { type: 'string' }
        },
        required: [
          'chunkId',
          'filingId',
          'filingDate',
          'formType',
          'sectionType',
          'score',
          'snippet'
        ]
      }
    }
  },
  required: ['cik', 'ticker', 'query', 'matches']
};

export const SemanticSearchOutputSchema = {
  type: 'object',
  oneOf: [SemanticSearchSuccessSchema, ErrorOutputSchema]
};

export const EarningsInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    year: { type: 'number' },
    quarter: { type: 'number' }
  }
};

const EarningsSuccessSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['ok', 'not_configured', 'not_found'] },
    callDate: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    tone: { type: ['string', 'null'] },
    guidanceChanges: { type: 'array', items: { type: 'string' } },
    keyQuotes: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'cik',
    'ticker',
    'status',
    'callDate',
    'summary',
    'tone',
    'guidanceChanges',
    'keyQuotes'
  ]
};

export const EarningsOutputSchema = {
  type: 'object',
  oneOf: [EarningsSuccessSchema, ErrorOutputSchema]
};
