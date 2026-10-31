const { URL } = require('url');

const TEST_DATABASE_PREFIX = 'connectsphere_test_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function parseDatabaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function connectionConfig({ database } = {}) {
  const urlConfig = parseDatabaseUrl(process.env.DATABASE_URL);
  const config = {
    host: process.env.DB_HOST || urlConfig?.host || 'localhost',
    port: Number(process.env.DB_PORT || urlConfig?.port || 5432),
    database: database || process.env.DB_NAME || urlConfig?.database || 'connectsphere',
    user: process.env.DB_USER || urlConfig?.user || 'postgres',
    password: process.env.DB_PASSWORD || urlConfig?.password || 'postgres',
  };

  if (process.env.NODE_ENV === 'test') {
    const expected = process.env.TEST_DATABASE_NAME;
    if (!expected || !expected.startsWith(TEST_DATABASE_PREFIX)) {
      throw new Error('Test database guard failed: TEST_DATABASE_NAME must use the connectsphere_test_ prefix.');
    }
    if (config.database !== expected || (urlConfig && urlConfig.database !== expected)) {
      throw new Error('Test database guard failed: every database setting must resolve to TEST_DATABASE_NAME.');
    }
  }

  return config;
}

function isLocalHost(host) {
  return LOCAL_HOSTS.has(host);
}

module.exports = { TEST_DATABASE_PREFIX, connectionConfig, isLocalHost };
