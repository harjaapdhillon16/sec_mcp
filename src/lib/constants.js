export const KEY_TAGS = [
  { tag: 'Revenues', label: 'Revenue' },
  { tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', label: 'Revenue (Contracts)' },
  { tag: 'SalesRevenueNet', label: 'Revenue (Net Sales)' },
  { tag: 'GrossProfit', label: 'Gross Profit' },
  { tag: 'OperatingIncomeLoss', label: 'Operating Income' },
  { tag: 'NetIncomeLoss', label: 'Net Income' },
  { tag: 'EarningsPerShareDiluted', label: 'EPS (Diluted)' },
  { tag: 'NetCashProvidedByUsedInOperatingActivities', label: 'Operating Cash Flow' },
  { tag: 'CapitalExpenditures', label: 'Capital Expenditures' },
  { tag: 'PaymentsToAcquirePropertyPlantAndEquipment', label: 'CapEx (Property)' },
  { tag: 'LongTermDebt', label: 'Long-Term Debt' },
  { tag: 'ResearchAndDevelopmentExpense', label: 'R&D Expense' },
  { tag: 'ShareBasedCompensation', label: 'Stock-Based Compensation' },
  { tag: 'Goodwill', label: 'Goodwill' },
  { tag: 'Assets', label: 'Total Assets' },
  { tag: 'AccountsReceivableNetCurrent', label: 'Accounts Receivable' },
];

export const DEFAULT_SECTIONS = ['risk_factors', 'mdna', 'business', 'legal'];

export const NEGATIVE_TERMS = [
  'risk',
  'adverse',
  'uncertain',
  'decline',
  'loss',
  'volatility',
  'material',
  'litigation',
  'regulatory',
  'challenge',
  'inflation',
  'recession',
  'supply',
  'chain',
  'liquidity',
  'impairment'
];

export const POSITIVE_TERMS = [
  'growth',
  'increase',
  'improve',
  'opportunity',
  'strong',
  'expand',
  'favorable',
  'profit',
  'record',
  'innovation'
];

// Words that signal hedged or uncertain language in management communications
export const HEDGING_TERMS = [
  'may', 'might', 'could', 'should', 'approximately', 'estimate', 'expect',
  'believe', 'anticipate', 'intend', 'project', 'likely', 'possible',
  'potential', 'contingent', 'assume', 'assumption', 'subject', 'depending',
  'uncertain', 'approximately', 'around', 'roughly', 'generally', 'typically'
];

// Language patterns that signal going concern or solvency risk
export const GOING_CONCERN_TERMS = [
  'going concern', 'substantial doubt', 'ability to continue', 'liquidity risk',
  'bankruptcy', 'insolvency', 'default on debt', 'covenant violation',
  'material weakness', 'significant deficiency', 'going-concern'
];

// Patterns that signal accounting policy changes or restatements
export const ACCOUNTING_CHANGE_TERMS = [
  'change in accounting', 'adopted asu', 'adopted fasb', 'accounting policy change',
  'retrospectively applied', 'restatement', 'restated', 'corrected prior period',
  'change in estimate', 'reclassified', 'reclassification'
];

// Patterns that signal related-party transactions
export const RELATED_PARTY_TERMS = [
  'related party', 'related-party', 'affiliated entity', 'officer loan',
  'director compensation', 'shareholder loan', 'insider transaction',
  'transactions with related', 'related person transaction'
];
