# SEC Filings + Earnings Intelligence MCP

Node.js + Express MCP server with Context security middleware, backed by Postgres + pgvector. Heavy compute (ingest, embeddings, comparisons) runs offline; MCP tool calls are fast and return structured JSON.

## Quick start

1) Install deps

```bash
npm install
```

2) Configure env

```bash
cp .env.example .env
```

Fill in at least:
- `DATABASE_URL`
- `SEC_USER_AGENT` (required by SEC)
- `OPENAI_API_KEY` (optional, for real embeddings)
- `FMP_API_KEY` (optional, for earnings transcripts)

3) Apply database schema

```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
```

4) Ingest filings (offline)

```bash
npm run ingest -- --ticker AAPL
```

5) Precompute intel (offline)

```bash
npm run precompute -- --ticker AAPL
```

6) Start MCP server

```bash
npm run start
```

## MCP tools

- `sec_latest_filing_intel`
  - Inputs: `ticker` or `cik`, optional `formType`, optional `includeSections`
  - Output: filing metadata, key metrics, takeaways, risk summary, signals

- `sec_compare_latest_to_previous`
  - Inputs: `ticker` or `cik`, optional `formType`
  - Output: metric deltas + narrative changes + citations

- `sec_semantic_search`
  - Inputs: `ticker` or `cik`, `query`, optional `sectionType`, optional `limit`
  - Output: top matching chunks with scores and snippets

- `earnings_call_intel`
  - Inputs: `ticker` or `cik`, optional `year`, `quarter`
  - Output: precomputed transcript intel (requires transcript ingest)

## Offline pipelines

### SEC ingest

```bash
npm run ingest -- --ticker AAPL --forms 10-Q,10-K
```

### Precompute comparisons

```bash
npm run precompute -- --ticker AAPL
```

### Transcripts ingest (optional)

Supply a transcript file (JSON or text):

```bash
npm run transcripts -- --file ./transcripts/aapl_q1_2025.json
```

JSON shape example:

```json
{
  "ticker": "AAPL",
  "cik": "0000320193",
  "callDate": "2025-01-30",
  "fiscalYear": 2025,
  "fiscalQuarter": 1,
  "transcriptText": "..."
}
```

## Notes

- The SEC requires a real `User-Agent` with contact info.
- Embeddings: set `OPENAI_API_KEY` for real vectors; otherwise a deterministic fallback is used.
- The `filing_chunks.embedding` column is set to dimension 1536. If you use a different embedding model, update the schema accordingly.

## Folder structure

- `src/server.js` - Express MCP server + Context middleware
- `src/mcp/` - tool schemas and handlers
- `src/workers/` - offline pipelines (ingest, precompute, transcripts)
- `db/migrations/` - Postgres schema + pgvector setup
