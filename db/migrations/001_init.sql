-- Enable extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Companies
CREATE TABLE IF NOT EXISTS companies (
  cik text PRIMARY KEY,
  ticker text UNIQUE,
  name text
);

-- Filings
CREATE TABLE IF NOT EXISTS filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik text REFERENCES companies(cik),
  accession text UNIQUE NOT NULL,
  form_type text NOT NULL,
  filing_date date NOT NULL,
  report_period date,
  primary_doc_url text,
  raw_text text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS filings_cik_form_date_idx ON filings (cik, form_type, filing_date DESC);

-- Filing sections
CREATE TABLE IF NOT EXISTS filing_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid REFERENCES filings(id) ON DELETE CASCADE,
  section_type text NOT NULL,
  content_text text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (filing_id, section_type)
);

-- Filing chunks
CREATE TABLE IF NOT EXISTS filing_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid REFERENCES filings(id) ON DELETE CASCADE,
  section_type text NOT NULL,
  chunk_index int NOT NULL,
  text text NOT NULL,
  chunk_hash text NOT NULL,
  token_count int,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  UNIQUE (filing_id, section_type, chunk_index)
);
CREATE INDEX IF NOT EXISTS filing_chunks_filing_idx ON filing_chunks (filing_id);
CREATE INDEX IF NOT EXISTS filing_chunks_section_idx ON filing_chunks (section_type);
CREATE INDEX IF NOT EXISTS filing_chunks_embedding_hnsw ON filing_chunks USING hnsw (embedding vector_cosine_ops);

-- XBRL facts
CREATE TABLE IF NOT EXISTS xbrl_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik text REFERENCES companies(cik),
  filing_id uuid REFERENCES filings(id) ON DELETE SET NULL,
  tag text NOT NULL,
  unit text,
  start_date date,
  end_date date,
  fy int,
  fp text,
  value double precision,
  created_at timestamptz DEFAULT now(),
  UNIQUE (cik, tag, unit, end_date, fp)
);
CREATE INDEX IF NOT EXISTS xbrl_facts_cik_tag_end_idx ON xbrl_facts (cik, tag, end_date DESC);

-- Precomputed intel reports
CREATE TABLE IF NOT EXISTS intel_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik text REFERENCES companies(cik),
  filing_id uuid REFERENCES filings(id) ON DELETE SET NULL,
  report_type text NOT NULL,
  data_json jsonb NOT NULL,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (cik, filing_id, report_type)
);

-- Comparisons
CREATE TABLE IF NOT EXISTS comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik text REFERENCES companies(cik),
  current_filing_id uuid REFERENCES filings(id) ON DELETE CASCADE,
  previous_filing_id uuid REFERENCES filings(id) ON DELETE CASCADE,
  diff_json jsonb NOT NULL,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (cik, current_filing_id, previous_filing_id)
);

-- Earnings calls (optional)
CREATE TABLE IF NOT EXISTS earnings_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cik text REFERENCES companies(cik),
  ticker text,
  call_date date,
  fiscal_year int,
  fiscal_quarter int,
  transcript_text text,
  source text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (cik, fiscal_year, fiscal_quarter)
);

CREATE TABLE IF NOT EXISTS earnings_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES earnings_calls(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  text text NOT NULL,
  chunk_hash text NOT NULL,
  token_count int,
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  UNIQUE (call_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS earnings_chunks_call_idx ON earnings_chunks (call_id);
CREATE INDEX IF NOT EXISTS earnings_chunks_embedding_hnsw ON earnings_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS earnings_intel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES earnings_calls(id) ON DELETE CASCADE,
  data_json jsonb NOT NULL,
  computed_at timestamptz DEFAULT now(),
  UNIQUE (call_id)
);
