import { load } from 'cheerio';
import { cleanText } from './utils.js';

const SECTION_DEFS = [
  { type: 'business', label: 'Business', pattern: /item\s+1\.?\s+business/i },
  { type: 'risk_factors', label: 'Risk Factors', pattern: /item\s+1a\.?\s+risk factors/i },
  { type: 'unresolved_staff_comments', label: 'Unresolved Staff Comments', pattern: /item\s+1b\.?\s+unresolved staff comments/i },
  { type: 'properties', label: 'Properties', pattern: /item\s+2\.?\s+properties/i },
  { type: 'legal', label: 'Legal Proceedings', pattern: /item\s+3\.?\s+legal proceedings/i },
  { type: 'market_risk', label: 'Market Risk', pattern: /item\s+7a\.?\s+quantitative and qualitative disclosures about market risk/i },
  { type: 'mdna', label: 'MD&A', pattern: /item\s+7\.?\s+management(?:'|\\u2019|`)?s discussion and analysis/i },
  { type: 'financial_statements', label: 'Financial Statements', pattern: /item\s+8\.?\s+financial statements/i },
  { type: 'controls', label: 'Controls and Procedures', pattern: /item\s+9a\.?\s+controls and procedures/i },
  { type: 'part2_item1a', label: 'Risk Factors (10-Q)', pattern: /item\s+1a\.?\s+risk factors/i },
  { type: 'part2_item7', label: 'MD&A (10-Q)', pattern: /item\s+2\.?\s+management(?:'|\\u2019|`)?s discussion and analysis/i }
];

export const htmlToText = (html) => {
  const $ = load(html || '');
  $('script,style,table,svg,footer,header,noscript').remove();
  const text = $('body').text();
  return cleanText(text);
};

export const extractSections = (text) => {
  if (!text) return {};
  const matches = [];
  for (const def of SECTION_DEFS) {
    const match = def.pattern.exec(text);
    if (match) {
      matches.push({
        type: def.type,
        label: def.label,
        index: match.index
      });
    }
  }
  if (!matches.length) {
    return { full_text: text };
  }
  const sorted = matches.sort((a, b) => a.index - b.index);
  const sections = {};
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const slice = text.slice(current.index, next ? next.index : text.length);
    const cleaned = cleanText(slice);
    if (cleaned.length > 200) {
      sections[current.type] = cleaned;
    }
  }
  if (!sections.risk_factors && sections.part2_item1a) {
    sections.risk_factors = sections.part2_item1a;
  }
  if (!sections.mdna && sections.part2_item7) {
    sections.mdna = sections.part2_item7;
  }
  return sections;
};
