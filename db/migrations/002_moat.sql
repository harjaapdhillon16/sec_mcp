-- GIN index for full-text search across filing chunk text (used by sec_sector_drift)
CREATE INDEX IF NOT EXISTS filing_chunks_text_gin
  ON filing_chunks USING gin(to_tsvector('english', text));

-- GIN index for full-text search across filing sections (used by sec_company_mentions)
CREATE INDEX IF NOT EXISTS filing_sections_text_gin
  ON filing_sections USING gin(to_tsvector('english', content_text));

-- Composite index to speed up cross-company date-filtered queries
CREATE INDEX IF NOT EXISTS filings_date_form_cik_idx
  ON filings (filing_date DESC, form_type, cik);

-- Index to support getAllEarningsIntel ordering
CREATE INDEX IF NOT EXISTS earnings_calls_cik_year_quarter_idx
  ON earnings_calls (cik, fiscal_year DESC NULLS LAST, fiscal_quarter DESC NULLS LAST);
