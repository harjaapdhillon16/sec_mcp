import pg from 'pg';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10
});

pool.on('connect', () => {
  logger.debug('DB connection acquired');
});

pool.on('error', (err) => {
  logger.error('DB pool error', { error: err?.message });
});

export const db = {
  pool,
  query: (text, params) => pool.query(text, params),
  withClient: async (fn) => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
};
