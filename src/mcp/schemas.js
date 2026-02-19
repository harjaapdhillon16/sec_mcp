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

/* -------------------------------------------------------------------------- */
/*                         CROSS-COMPANY SCAN                                 */
/* -------------------------------------------------------------------------- */

export const CrossCompanyScanInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Semantic query to find across all company filings'
    },
    tickers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: restrict to these tickers. If omitted, searches all ingested companies.'
    },
    sectionType: {
      type: 'string',
      description: 'Optional: restrict to a specific filing section (e.g. risk_factors, mdna)'
    },
    limit: { type: 'number', default: 20 },
    lookbackDays: {
      type: 'number',
      description: 'Only search filings filed within the last N days'
    },
    minScore: { type: 'number', default: 0.3 }
  },
  required: ['query']
};

export const CrossCompanyScanOutputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    companiesFound: { type: 'number' },
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cik: { type: 'string' },
          ticker: { type: ['string', 'null'] },
          topScore: { type: 'number' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filingDate: { type: 'string' },
                formType: { type: 'string' },
                sectionType: { type: 'string' },
                score: { type: 'number' },
                snippet: { type: 'string' }
              }
            }
          }
        }
      }
    }
  },
  required: ['query', 'companiesFound', 'companies']
};

/* -------------------------------------------------------------------------- */
/*                           DERIVED METRICS                                  */
/* -------------------------------------------------------------------------- */

export const DerivedMetricsInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' }
  }
};

export const DerivedMetricsOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    filingDate: { type: ['string', 'null'] },
    reportPeriod: { type: ['string', 'null'] },
    derivedMetrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'number' },
          formula: { type: 'string' },
          description: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['name', 'value', 'formula', 'description', 'confidence']
      }
    },
    missingInputs: { type: 'array', items: { type: 'string' } }
  },
  required: ['cik', 'ticker', 'filingDate', 'reportPeriod', 'derivedMetrics', 'missingInputs']
};

/* -------------------------------------------------------------------------- */
/*                        MANAGEMENT CREDIBILITY                              */
/* -------------------------------------------------------------------------- */

export const ManagementCredibilityInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    periods: {
      type: 'number',
      default: 8,
      description: 'Number of earnings call quarters to analyze'
    }
  }
};

export const ManagementCredibilityOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    periodsAnalyzed: { type: 'number' },
    overallCredibilityScore: { type: ['number', 'null'] },
    hedgingTrend: { type: 'string' },
    toneProgression: { type: 'string' },
    history: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fiscalYear: { type: ['number', 'null'] },
          fiscalQuarter: { type: ['number', 'null'] },
          callDate: { type: ['string', 'null'] },
          tone: { type: ['string', 'null'] },
          hedgingDensity: { type: 'number' },
          guidanceCount: { type: 'number' },
          guidanceStatements: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  },
  required: ['cik', 'ticker', 'periodsAnalyzed', 'overallCredibilityScore', 'hedgingTrend', 'toneProgression', 'history']
};

/* -------------------------------------------------------------------------- */
/*                           FILING ANOMALY                                   */
/* -------------------------------------------------------------------------- */

export const FilingAnomalyInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' }
  }
};

export const FilingAnomalyOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    filingDate: { type: ['string', 'null'] },
    formType: { type: 'string' },
    reportPeriod: { type: ['string', 'null'] },
    anomalyScore: { type: 'number', description: '0 = normal, 1 = highly anomalous' },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          description: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['type', 'severity', 'description', 'evidence']
      }
    },
    baseline: { type: 'object' }
  },
  required: ['cik', 'ticker', 'filingDate', 'formType', 'reportPeriod', 'anomalyScore', 'flags', 'baseline']
};

/* -------------------------------------------------------------------------- */
/*                            EARNINGS Q&A                                    */
/* -------------------------------------------------------------------------- */

export const EarningsQaInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    year: { type: 'number' },
    quarter: { type: 'number' }
  }
};

export const EarningsQaOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    callDate: { type: ['string', 'null'] },
    totalQuestions: { type: 'number' },
    deflectionRate: { type: 'number' },
    analystThemes: { type: 'array', items: { type: 'string' } },
    deflectedTopics: { type: 'array', items: { type: 'string' } },
    firstTimeMentions: { type: 'array', items: { type: 'string' } },
    qaExcerpts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          question: { type: 'string' },
          response: { type: ['string', 'null'] },
          deflected: { type: 'boolean' }
        }
      }
    }
  },
  required: ['cik', 'ticker', 'callDate', 'totalQuestions', 'deflectionRate', 'analystThemes', 'deflectedTopics', 'firstTimeMentions', 'qaExcerpts']
};

/* -------------------------------------------------------------------------- */
/*                          LONGITUDINAL TONE                                 */
/* -------------------------------------------------------------------------- */

export const LongitudinalToneInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    periods: { type: 'number', default: 8 }
  }
};

export const LongitudinalToneOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    periodsAnalyzed: { type: 'number' },
    periods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fiscalYear: { type: ['number', 'null'] },
          fiscalQuarter: { type: ['number', 'null'] },
          callDate: { type: ['string', 'null'] },
          earningsTone: { type: ['string', 'null'] },
          guidanceCount: { type: 'number' },
          hedgingDensity: { type: 'number' }
        }
      }
    },
    trendSummary: { type: 'string' }
  },
  required: ['cik', 'ticker', 'periodsAnalyzed', 'periods', 'trendSummary']
};

/* -------------------------------------------------------------------------- */
/*                            SECTOR DRIFT                                    */
/* -------------------------------------------------------------------------- */

export const SectorDriftInputSchema = {
  type: 'object',
  properties: {
    term: {
      type: 'string',
      description: 'Term or phrase to track across all filings'
    },
    tickers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional: restrict to these tickers'
    },
    lookbackDays: {
      type: 'number',
      default: 90,
      description: 'Window for "recent" filings'
    },
    limit: { type: 'number', default: 30 }
  },
  required: ['term']
};

export const SectorDriftOutputSchema = {
  type: 'object',
  properties: {
    term: { type: 'string' },
    lookbackDays: { type: 'number' },
    recentMentions: { type: 'number' },
    historicalMentions: { type: 'number' },
    driftScore: { type: ['number', 'null'] },
    emergingCompanies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cik: { type: 'string' },
          ticker: { type: ['string', 'null'] },
          filingDate: { type: 'string' },
          formType: { type: 'string' },
          sectionType: { type: 'string' },
          snippet: { type: 'string' }
        }
      }
    }
  },
  required: ['term', 'lookbackDays', 'recentMentions', 'historicalMentions', 'driftScore', 'emergingCompanies']
};

/* -------------------------------------------------------------------------- */
/*                          COMPANY MENTIONS                                  */
/* -------------------------------------------------------------------------- */

export const CompanyMentionsInputSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    cik: { type: 'string' },
    sectionTypes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Sections to search. Defaults to ["business", "mdna"]'
    }
  }
};

export const CompanyMentionsOutputSchema = {
  type: 'object',
  properties: {
    cik: { type: 'string' },
    ticker: { type: ['string', 'null'] },
    filingDate: { type: ['string', 'null'] },
    mentionsFound: { type: 'number' },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mentionedTicker: { type: ['string', 'null'] },
          mentionedName: { type: 'string' },
          relationshipKeywords: { type: 'array', items: { type: 'string' } },
          sentences: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    relationshipSentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          relationshipType: { type: 'string' },
          sentence: { type: 'string' }
        }
      }
    }
  },
  required: ['cik', 'ticker', 'filingDate', 'mentionsFound', 'mentions', 'relationshipSentences']
};
