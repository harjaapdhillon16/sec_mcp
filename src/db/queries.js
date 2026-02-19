import { db } from './index.js';

export const toVectorLiteral = (embedding) => {
  if (!Array.isArray(embedding)) return null;
  return `[${embedding.map(v => Number(v).toFixed(6)).join(',')}]`;
};

export const normalizeCik = (value) => {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.padStart(10, '0');
};

export const upsertCompany = async ({ cik, ticker, name }) => {
  const result = await db.query(
    `
    INSERT INTO companies (cik, ticker, name)
    VALUES ($1, $2, $3)
    ON CONFLICT (cik) DO UPDATE
    SET ticker = COALESCE(EXCLUDED.ticker, companies.ticker),
        name = COALESCE(EXCLUDED.name, companies.name)
    RETURNING *
    `,
    [cik, ticker, name]
  );
  return result.rows[0];
};

export const getCompanyByTicker = async (ticker) => {
  const result = await db.query(
    `SELECT * FROM companies WHERE ticker = $1 LIMIT 1`,
    [ticker]
  );
  return result.rows[0] || null;
};

export const getCompanyByCik = async (cik) => {
  const result = await db.query(
    `SELECT * FROM companies WHERE cik = $1 LIMIT 1`,
    [cik]
  );
  return result.rows[0] || null;
};

export const listCompanies = async () => {
  const result = await db.query(`SELECT * FROM companies ORDER BY ticker NULLS LAST`);
  return result.rows;
};

export const upsertFiling = async (filing) => {
  const {
    cik,
    accession,
    formType,
    filingDate,
    reportPeriod,
    primaryDocUrl,
    rawText
  } = filing;
  const result = await db.query(
    `
    INSERT INTO filings (cik, accession, form_type, filing_date, report_period, primary_doc_url, raw_text)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (accession) DO UPDATE
    SET form_type = EXCLUDED.form_type,
        filing_date = EXCLUDED.filing_date,
        report_period = EXCLUDED.report_period,
        primary_doc_url = EXCLUDED.primary_doc_url,
        raw_text = COALESCE(EXCLUDED.raw_text, filings.raw_text)
    RETURNING *
    `,
    [cik, accession, formType, filingDate, reportPeriod, primaryDocUrl, rawText]
  );
  return result.rows[0];
};

export const getFilingByAccession = async (accession) => {
  const result = await db.query(
    `SELECT * FROM filings WHERE accession = $1 LIMIT 1`,
    [accession]
  );
  return result.rows[0] || null;
};

export const getLatestFiling = async (cik, formType = null) => {
  if (formType) {
    const result = await db.query(
      `
      SELECT * FROM filings
      WHERE cik = $1 AND form_type = $2
      ORDER BY filing_date DESC
      LIMIT 1
      `,
      [cik, formType]
    );
    return result.rows[0] || null;
  }
  const result = await db.query(
    `
    SELECT * FROM filings
    WHERE cik = $1 AND form_type IN ('10-Q', '10-K')
    ORDER BY filing_date DESC
    LIMIT 1
    `,
    [cik]
  );
  return result.rows[0] || null;
};

export const getPreviousFiling = async (cik, formType, beforeDate) => {
  const result = await db.query(
    `
    SELECT * FROM filings
    WHERE cik = $1 AND form_type = $2 AND filing_date < $3
    ORDER BY filing_date DESC
    LIMIT 1
    `,
    [cik, formType, beforeDate]
  );
  return result.rows[0] || null;
};

export const listRecentFilings = async (cik, limit = 5) => {
  const result = await db.query(
    `
    SELECT * FROM filings
    WHERE cik = $1
    ORDER BY filing_date DESC
    LIMIT $2
    `,
    [cik, limit]
  );
  return result.rows;
};

export const upsertFilingSection = async ({
  filingId,
  sectionType,
  contentText,
  contentHash
}) => {
  const result = await db.query(
    `
    INSERT INTO filing_sections (filing_id, section_type, content_text, content_hash)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (filing_id, section_type) DO UPDATE
    SET content_text = EXCLUDED.content_text,
        content_hash = EXCLUDED.content_hash
    RETURNING *
    `,
    [filingId, sectionType, contentText, contentHash]
  );
  return result.rows[0];
};

export const getSectionByFiling = async (filingId, sectionType) => {
  const result = await db.query(
    `
    SELECT * FROM filing_sections
    WHERE filing_id = $1 AND section_type = $2
    LIMIT 1
    `,
    [filingId, sectionType]
  );
  return result.rows[0] || null;
};

export const getSectionsByFiling = async (filingId) => {
  const result = await db.query(
    `SELECT * FROM filing_sections WHERE filing_id = $1`,
    [filingId]
  );
  return result.rows;
};

export const deleteChunksForSection = async (filingId, sectionType) => {
  await db.query(
    `DELETE FROM filing_chunks WHERE filing_id = $1 AND section_type = $2`,
    [filingId, sectionType]
  );
};

export const insertFilingChunks = async (chunks) => {
  if (!chunks.length) return;
  const values = [];
  const params = [];
  let idx = 1;
  for (const chunk of chunks) {
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}::vector, $${idx++})`
    );
    params.push(
      chunk.filingId,
      chunk.sectionType,
      chunk.chunkIndex,
      chunk.text,
      chunk.chunkHash,
      toVectorLiteral(chunk.embedding),
      chunk.tokenCount
    );
  }
  await db.query(
    `
    INSERT INTO filing_chunks
      (filing_id, section_type, chunk_index, text, chunk_hash, embedding, token_count)
    VALUES ${values.join(', ')}
    ON CONFLICT (filing_id, section_type, chunk_index) DO UPDATE
    SET text = EXCLUDED.text,
        chunk_hash = EXCLUDED.chunk_hash,
        embedding = EXCLUDED.embedding,
        token_count = EXCLUDED.token_count
    `,
    params
  );
};

export const getSectionChunks = async (filingId, sectionType, limit = 5) => {
  const result = await db.query(
    `
    SELECT id, text
    FROM filing_chunks
    WHERE filing_id = $1 AND section_type = $2
    ORDER BY chunk_index ASC
    LIMIT $3
    `,
    [filingId, sectionType, limit]
  );
  return result.rows;
};

export const insertXbrlFacts = async (facts) => {
  if (!facts.length) return;
  const deduped = new Map();
  for (const fact of facts) {
    if (!fact.endDate || !fact.tag) continue;
    const key = `${fact.cik}|${fact.tag}|${fact.unit || ''}|${fact.endDate}|${fact.fp || ''}`;
    deduped.set(key, fact);
  }
  const rowsToInsert = Array.from(deduped.values());
  if (!rowsToInsert.length) return;
  const values = [];
  const params = [];
  let idx = 1;
  for (const fact of rowsToInsert) {
    values.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
    );
    params.push(
      fact.cik,
      fact.filingId,
      fact.tag,
      fact.unit,
      fact.startDate,
      fact.endDate,
      fact.fy,
      fact.fp,
      fact.value
    );
  }
  await db.query(
    `
    INSERT INTO xbrl_facts
      (cik, filing_id, tag, unit, start_date, end_date, fy, fp, value)
    VALUES ${values.join(', ')}
    ON CONFLICT (cik, tag, unit, end_date, fp) DO UPDATE
    SET value = EXCLUDED.value,
        start_date = EXCLUDED.start_date,
        fy = EXCLUDED.fy,
        filing_id = COALESCE(EXCLUDED.filing_id, xbrl_facts.filing_id)
    `,
    params
  );
};

export const getFactsForPeriod = async (cik, endDate, tags) => {
  const result = await db.query(
    `
    SELECT * FROM xbrl_facts
    WHERE cik = $1
      AND tag = ANY($2)
      AND end_date = $3
    ORDER BY tag
    `,
    [cik, tags, endDate]
  );
  return result.rows;
};

export const getLatestFactsByTag = async (cik, tags) => {
  const result = await db.query(
    `
    SELECT DISTINCT ON (tag) *
    FROM xbrl_facts
    WHERE cik = $1 AND tag = ANY($2)
    ORDER BY tag, end_date DESC
    `,
    [cik, tags]
  );
  return result.rows;
};

export const upsertIntelReport = async ({
  cik,
  filingId,
  reportType,
  dataJson
}) => {
  const result = await db.query(
    `
    INSERT INTO intel_reports (cik, filing_id, report_type, data_json)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (cik, filing_id, report_type) DO UPDATE
    SET data_json = EXCLUDED.data_json,
        computed_at = NOW()
    RETURNING *
    `,
    [cik, filingId, reportType, dataJson]
  );
  return result.rows[0];
};

export const getIntelReport = async (cik, filingId, reportType) => {
  const result = await db.query(
    `
    SELECT * FROM intel_reports
    WHERE cik = $1 AND filing_id = $2 AND report_type = $3
    LIMIT 1
    `,
    [cik, filingId, reportType]
  );
  return result.rows[0] || null;
};

export const upsertComparison = async ({
  cik,
  currentFilingId,
  previousFilingId,
  diffJson
}) => {
  const result = await db.query(
    `
    INSERT INTO comparisons (cik, current_filing_id, previous_filing_id, diff_json)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (cik, current_filing_id, previous_filing_id) DO UPDATE
    SET diff_json = EXCLUDED.diff_json,
        computed_at = NOW()
    RETURNING *
    `,
    [cik, currentFilingId, previousFilingId, diffJson]
  );
  return result.rows[0];
};

export const getComparison = async (cik, currentFilingId, previousFilingId) => {
  const result = await db.query(
    `
    SELECT * FROM comparisons
    WHERE cik = $1 AND current_filing_id = $2 AND previous_filing_id = $3
    LIMIT 1
    `,
    [cik, currentFilingId, previousFilingId]
  );
  return result.rows[0] || null;
};

export const searchChunksByEmbedding = async ({
  cik,
  embedding,
  limit = 8,
  sectionType = null,
  minFilingDate = null,
  maxFilingDate = null
}) => {
  const params = [toVectorLiteral(embedding), cik];
  const filters = [];
  let paramIndex = 3;

  if (sectionType) {
    filters.push(`c.section_type = $${paramIndex++}`);
    params.push(sectionType);
  }
  if (minFilingDate) {
    filters.push(`f.filing_date >= $${paramIndex++}`);
    params.push(minFilingDate);
  }
  if (maxFilingDate) {
    filters.push(`f.filing_date <= $${paramIndex++}`);
    params.push(maxFilingDate);
  }

  const filter = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const limitIndex = paramIndex++;
  params.push(limit);
  const result = await db.query(
    `
    SELECT c.id, c.text, c.section_type, c.filing_id,
           f.form_type, f.filing_date,
           (1 - (c.embedding <=> $1::vector)) AS score
    FROM filing_chunks c
    JOIN filings f ON f.id = c.filing_id
    WHERE f.cik = $2
    ${filter}
    ORDER BY c.embedding <=> $1::vector, f.filing_date DESC
    LIMIT $${limitIndex}
    `,
    params
  );
  return result.rows;
};

export const upsertEarningsCall = async ({
  cik,
  ticker,
  callDate,
  fiscalYear,
  fiscalQuarter,
  transcriptText,
  source
}) => {
  const result = await db.query(
    `
    INSERT INTO earnings_calls (cik, ticker, call_date, fiscal_year, fiscal_quarter, transcript_text, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (cik, fiscal_year, fiscal_quarter) DO UPDATE
    SET call_date = EXCLUDED.call_date,
        ticker = COALESCE(EXCLUDED.ticker, earnings_calls.ticker),
        transcript_text = COALESCE(EXCLUDED.transcript_text, earnings_calls.transcript_text),
        source = EXCLUDED.source
    RETURNING *
    `,
    [cik, ticker, callDate, fiscalYear, fiscalQuarter, transcriptText, source]
  );
  return result.rows[0];
};

export const deleteEarningsChunks = async (callId) => {
  await db.query(`DELETE FROM earnings_chunks WHERE call_id = $1`, [callId]);
};

export const insertEarningsChunks = async (chunks) => {
  if (!chunks.length) return;
  const values = [];
  const params = [];
  let idx = 1;
  for (const chunk of chunks) {
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}::vector, $${idx++})`);
    params.push(
      chunk.callId,
      chunk.chunkIndex,
      chunk.text,
      chunk.chunkHash,
      toVectorLiteral(chunk.embedding),
      chunk.tokenCount
    );
  }
  await db.query(
    `
    INSERT INTO earnings_chunks (call_id, chunk_index, text, chunk_hash, embedding, token_count)
    VALUES ${values.join(', ')}
    ON CONFLICT (call_id, chunk_index) DO UPDATE
    SET text = EXCLUDED.text,
        chunk_hash = EXCLUDED.chunk_hash,
        embedding = EXCLUDED.embedding,
        token_count = EXCLUDED.token_count
    `,
    params
  );
};

export const upsertEarningsIntel = async ({ callId, dataJson }) => {
  const result = await db.query(
    `
    INSERT INTO earnings_intel (call_id, data_json)
    VALUES ($1, $2)
    ON CONFLICT (call_id) DO UPDATE
    SET data_json = EXCLUDED.data_json,
        computed_at = NOW()
    RETURNING *
    `,
    [callId, dataJson]
  );
  return result.rows[0];
};

export const getEarningsIntel = async ({ cik, fiscalYear, fiscalQuarter }) => {
  const result = await db.query(
    `
    SELECT e.call_date, e.cik, e.ticker, i.data_json
    FROM earnings_calls e
    JOIN earnings_intel i ON i.call_id = e.id
    WHERE e.cik = $1
      AND ($2::int IS NULL OR e.fiscal_year = $2)
      AND ($3::int IS NULL OR e.fiscal_quarter = $3)
    ORDER BY e.call_date DESC NULLS LAST
    LIMIT 1
    `,
    [cik, fiscalYear || null, fiscalQuarter || null]
  );
  return result.rows[0] || null;
};

// Get raw earnings call record including transcript_text (for Q&A analysis)
export const getEarningsCall = async ({ cik, fiscalYear, fiscalQuarter }) => {
  const result = await db.query(
    `
    SELECT *
    FROM earnings_calls
    WHERE cik = $1
      AND ($2::int IS NULL OR fiscal_year = $2)
      AND ($3::int IS NULL OR fiscal_quarter = $3)
    ORDER BY fiscal_year DESC NULLS LAST, fiscal_quarter DESC NULLS LAST,
             call_date DESC NULLS LAST
    LIMIT 1
    `,
    [cik, fiscalYear || null, fiscalQuarter || null]
  );
  return result.rows[0] || null;
};

// Get all earnings intel + transcript text for a company, ordered newest first
export const getAllEarningsIntel = async (cik, limit = 12) => {
  const result = await db.query(
    `
    SELECT e.id, e.call_date, e.cik, e.ticker,
           e.fiscal_year, e.fiscal_quarter, e.transcript_text,
           i.data_json
    FROM earnings_calls e
    LEFT JOIN earnings_intel i ON i.call_id = e.id
    WHERE e.cik = $1
    ORDER BY e.fiscal_year DESC NULLS LAST, e.fiscal_quarter DESC NULLS LAST,
             e.call_date DESC NULLS LAST
    LIMIT $2
    `,
    [cik, limit]
  );
  return result.rows;
};

// Get recent filings for a company ordered by date (for anomaly baseline)
export const getFilingHistory = async (cik, formType = null, limit = 8) => {
  const result = await db.query(
    `
    SELECT id, cik, form_type, filing_date, report_period, primary_doc_url
    FROM filings
    WHERE cik = $1
      AND ($2::text IS NULL OR form_type = $2)
    ORDER BY filing_date DESC
    LIMIT $3
    `,
    [cik, formType, limit]
  );
  return result.rows;
};

// Get all XBRL facts for a company across all periods (for derived metric history)
export const getFactsAllPeriods = async (cik, tags) => {
  const result = await db.query(
    `
    SELECT *
    FROM xbrl_facts
    WHERE cik = $1 AND tag = ANY($2)
    ORDER BY end_date DESC
    LIMIT 100
    `,
    [cik, tags]
  );
  return result.rows;
};

// Semantic search across ALL companies (no cik filter), optional ticker filter
export const searchChunksCrossCompany = async ({
  embedding,
  tickers = [],
  sectionType = null,
  minScore = 0.3,
  limit = 50,
  lookbackDays = null,
}) => {
  const vectorLiteral = toVectorLiteral(embedding);
  const params = [vectorLiteral];
  const filters = [];
  let paramIndex = 2;

  if (tickers.length > 0) {
    filters.push(`co.ticker = ANY($${paramIndex++})`);
    params.push(tickers);
  }
  if (sectionType) {
    filters.push(`c.section_type = $${paramIndex++}`);
    params.push(sectionType);
  }
  if (lookbackDays) {
    filters.push(`f.filing_date >= CURRENT_DATE - ($${paramIndex++} * INTERVAL '1 day')`);
    params.push(lookbackDays);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limitIndex = paramIndex++;
  params.push(limit);

  const result = await db.query(
    `
    SELECT c.id, c.text, c.section_type, c.filing_id,
           f.form_type, f.filing_date, f.cik,
           co.ticker,
           (1 - (c.embedding <=> $1::vector)) AS score
    FROM filing_chunks c
    JOIN filings f ON f.id = c.filing_id
    JOIN companies co ON co.cik = f.cik
    ${whereClause}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $${limitIndex}
    `,
    params
  );

  // Filter by minScore in application layer to preserve HNSW index usage
  return result.rows.filter((row) => Number(row.score) >= minScore);
};

// Full-text keyword search across filing chunks (for sector drift detection)
export const searchTextInChunks = async ({
  term,
  tickers = [],
  sectionType = null,
  limit = 60,
  lookbackDays = null,
}) => {
  const params = [`%${term}%`];
  const filters = [`c.text ILIKE $1`];
  let paramIndex = 2;

  if (tickers.length > 0) {
    filters.push(`co.ticker = ANY($${paramIndex++})`);
    params.push(tickers);
  }
  if (sectionType) {
    filters.push(`c.section_type = $${paramIndex++}`);
    params.push(sectionType);
  }
  if (lookbackDays) {
    filters.push(`f.filing_date >= CURRENT_DATE - ($${paramIndex++} * INTERVAL '1 day')`);
    params.push(lookbackDays);
  }

  const limitIndex = paramIndex++;
  params.push(limit);

  const result = await db.query(
    `
    SELECT c.id, c.text, c.section_type, c.filing_id,
           f.form_type, f.filing_date, f.cik,
           co.ticker
    FROM filing_chunks c
    JOIN filings f ON f.id = c.filing_id
    JOIN companies co ON co.cik = f.cik
    WHERE ${filters.join(' AND ')}
    ORDER BY f.filing_date DESC
    LIMIT $${limitIndex}
    `,
    params
  );
  return result.rows;
};
