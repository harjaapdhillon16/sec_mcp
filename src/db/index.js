import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10
});

pool.on('connect', () => {
});

pool.on('error', (err) => {
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
