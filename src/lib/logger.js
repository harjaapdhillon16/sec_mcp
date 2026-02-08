import crypto from 'node:crypto';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const normalizeLevel = (level) => {
  const key = String(level || 'info').toLowerCase();
  return LEVELS[key] ? key : 'info';
};

const redactedKeys = [
  'authorization',
  'api_key',
  'apikey',
  'token',
  'password',
  'secret',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-context-token',
  'x-context-signature',
  'x-context-authorization',
  'access-token',
  'refresh-token',
  'private-key'
];

const redactValue = (value) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= 6) return '***';
    return `${value.slice(0, 3)}***${value.slice(-2)}`;
  }
  return '***';
};

const redact = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (redactedKeys.includes(key.toLowerCase())) {
      out[key] = redactValue(value);
    } else if (typeof value === 'object' && value !== null) {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

const normalizeMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return meta;
  const out = { ...meta };
  const error = out.error;
  if (error instanceof Error) {
    out.error = error.message;
    if (error.stack) out.errorStack = error.stack;
    if (error.code) out.errorCode = error.code;
  } else if (error && typeof error === 'object' && error.message) {
    out.error = error.message;
    if (error.stack) out.errorStack = error.stack;
    if (error.code) out.errorCode = error.code;
  }
  return out;
};

const format = (level, message, meta) => {
  const time = new Date().toISOString();
  const normalized = normalizeMeta(meta);
  if (normalized && Object.keys(normalized).length) {
    return `${time} ${level.toUpperCase()} ${message} ${JSON.stringify(redact(normalized))}`;
  }
  return `${time} ${level.toUpperCase()} ${message}`;
};

const createLogger = (level = 'info', context = {}) => {
  const current = normalizeLevel(level);
  const threshold = LEVELS[current];
  const log = (lvl, message, meta = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const mergedMeta = { ...context, ...meta };
    const line = format(lvl, message, mergedMeta);
    if (lvl === 'error') {
      console.error(line);
    } else if (lvl === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };
  return {
    level: current,
    child: (extra) => createLogger(current, { ...context, ...extra }),
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta)
  };
};

export const createRequestId = () => crypto.randomUUID();

export const logger = createLogger(process.env.LOG_LEVEL || 'info');

export const withTimer = (log, name) => {
  const start = Date.now();
  return () => {
    const ms = Date.now() - start;
    log.info(`${name} completed`, { durationMs: ms });
  };
};
