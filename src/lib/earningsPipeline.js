import { config } from '../config.js';
import { chunkText } from './chunker.js';
import { embedTexts } from './embeddings.js';
import { sha256 } from './utils.js';
import { buildEarningsIntel } from './earningsIntel.js';
import {
  upsertEarningsCall,
  deleteEarningsChunks,
  insertEarningsChunks,
  upsertEarningsIntel
} from '../db/queries.js';
import { logger } from './logger.js';

export const ingestEarningsTranscript = async ({
  cik,
  ticker,
  callDate,
  fiscalYear,
  fiscalQuarter,
  transcriptText,
  source
}) => {
  if (!transcriptText) {
    logger.warn('No transcript text provided', { cik, ticker, source });
    return null;
  }

  const call = await upsertEarningsCall({
    cik,
    ticker,
    callDate,
    fiscalYear,
    fiscalQuarter,
    transcriptText,
    source
  });

  await deleteEarningsChunks(call.id);
  const chunks = chunkText(transcriptText, config.chunkMaxWords, config.chunkOverlapWords, config.embeddingMaxTokens);
  const embeddings = await embedTexts(chunks.map(chunk => chunk.text));
  const rows = chunks.map((chunk, index) => ({
    callId: call.id,
    chunkIndex: index,
    text: chunk.text,
    chunkHash: sha256(chunk.text),
    embedding: embeddings[index],
    tokenCount: chunk.tokenCount
  }));
  await insertEarningsChunks(rows);

  const intel = buildEarningsIntel(transcriptText);
  await upsertEarningsIntel({ callId: call.id, dataJson: intel });

  logger.info('Earnings transcript stored', {
    cik,
    ticker,
    fiscalYear,
    fiscalQuarter,
    chunks: rows.length,
    source
  });

  return call;
};
