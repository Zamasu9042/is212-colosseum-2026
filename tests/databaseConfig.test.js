const {
  TEST_DATABASE_PREFIX,
  connectionConfig,
  isLocalHost,
} = require('../src/config/databaseConfig');

const DB_ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'TEST_DATABASE_NAME',
];

const originalEnvironment = Object.fromEntries(DB_ENV_KEYS.map((key) => [key, process.env[key]]));

function setEnvironment(values = {}) {
  for (const key of DB_ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => setEnvironment(originalEnvironment));

describe('Database configuration', () => {
  test('uses default connection settings when no database URL or DB variables are configured', () => {
    setEnvironment();

    expect(connectionConfig()).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'connectsphere',
      user: 'postgres',
      password: 'postgres',
    });
  });

  test('parses encoded database URL credentials and database names', () => {
    setEnvironment({
      DATABASE_URL: 'postgresql://user%40example.com:pa%24%24word@db.example.test:6543/connect%2Fsphere',
    });

    expect(connectionConfig()).toEqual({
      host: 'db.example.test',
      port: 6543,
      database: 'connect/sphere',
      user: 'user@example.com',
      password: 'pa$$word',
    });
  });

  test('defaults a database URL without an explicit port to PostgreSQL port 5432', () => {
    setEnvironment({ DATABASE_URL: 'postgresql://url-user:url-password@db.example.test/url_database' });

    expect(connectionConfig()).toMatchObject({
      host: 'db.example.test',
      port: 5432,
      database: 'url_database',
    });
  });

  test('prefers explicit DB environment variables over database URL values', () => {
    setEnvironment({
      DATABASE_URL: 'postgresql://url-user:url-password@url-host.test:6543/url_database',
      DB_HOST: 'explicit-host.test',
      DB_PORT: '5433',
      DB_NAME: 'explicit_database',
      DB_USER: 'explicit-user',
      DB_PASSWORD: 'explicit-password',
    });

    expect(connectionConfig()).toEqual({
      host: 'explicit-host.test',
      port: 5433,
      database: 'explicit_database',
      user: 'explicit-user',
      password: 'explicit-password',
    });
  });

  test('rejects a test database name without the required prefix', () => {
    setEnvironment({ NODE_ENV: 'test', TEST_DATABASE_NAME: 'connectsphere_development' });

    expect(() => connectionConfig()).toThrow(
      'Test database guard failed: TEST_DATABASE_NAME must use the connectsphere_test_ prefix.'
    );
  });

  test('rejects conflicting database URL and test database names', () => {
    const expected = `${TEST_DATABASE_PREFIX}expected`;
    setEnvironment({
      NODE_ENV: 'test',
      TEST_DATABASE_NAME: expected,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/connectsphere_test_other',
    });

    expect(() => connectionConfig()).toThrow(
      'Test database guard failed: every database setting must resolve to TEST_DATABASE_NAME.'
    );
  });

  test('recognises localhost IPv4 and IPv6 loopback hosts as local', () => {
    expect(['localhost', '127.0.0.1', '::1'].every(isLocalHost)).toBe(true);
  });

  test('rejects remote hosts as non-local', () => {
    expect(isLocalHost('db.example.test')).toBe(false);
    expect(isLocalHost('192.0.2.10')).toBe(false);
  });
});
