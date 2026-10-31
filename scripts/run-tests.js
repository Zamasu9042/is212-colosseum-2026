/*
 * Creates one disposable PostgreSQL database for a Jest invocation. The
 * persistent development/demo database is never used by this script.
 */
require('dotenv').config();
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { connectionConfig, isLocalHost, TEST_DATABASE_PREFIX } = require('../src/config/databaseConfig');

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('Unsafe generated database name.');
  return `"${value}"`;
}

function databaseUrl(config) {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${host}:${config.port}/${config.database}`;
}

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function runJest(args, env, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', ...args], { stdio: 'inherit', env });
    onChild(child);
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const source = connectionConfig();
  if (process.env.NODE_ENV === 'production' || !isLocalHost(source.host)) {
    throw new Error('Automated tests require a local PostgreSQL host and refuse production settings.');
  }

  const testDatabase = `${TEST_DATABASE_PREFIX}${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminConfig = { ...source, database: process.env.TEST_DB_ADMIN_NAME || 'postgres' };
  const testConfig = { ...source, database: testDatabase };
  const testEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DB_HOST: testConfig.host,
    DB_PORT: String(testConfig.port),
    DB_NAME: testDatabase,
    DB_USER: testConfig.user,
    DB_PASSWORD: testConfig.password,
    DATABASE_URL: databaseUrl(testConfig),
    TEST_DATABASE_NAME: testDatabase,
  };
  const admin = new Client(adminConfig);
  let created = false;
  let cleaning = false;
  let child;
  let signalExitCode = null;

  async function cleanup() {
    if (cleaning || !created) return true;
    cleaning = true;
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [testDatabase]);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabase)}`);
      created = false;
      console.log(`✓ Removed temporary test database: ${testDatabase}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to remove temporary test database ${testDatabase}: ${error.message}`);
      return false;
    } finally {
      cleaning = false;
    }
  }

  const handleSignal = (signal) => {
    signalExitCode = signal === 'SIGINT' ? 130 : 143;
    if (child && !child.killed) child.kill(signal);
    cleanup().finally(async () => {
      await admin.end().catch(() => {});
      process.exit(signalExitCode);
    });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  let jestExitCode = 1;
  try {
    await admin.connect();
    // The lock lives on this dedicated admin connection until cleanup finishes.
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [testDatabase]);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabase)}`);
    created = true;
    console.log(`Created isolated test database: ${testDatabase}`);

    for (const script of ['scripts/init-db.js', 'scripts/seed-roles.js', 'scripts/verify-test-database.js']) {
      const code = await runNode(script, testEnv);
      if (code !== 0) throw new Error(`${script} failed with exit code ${code}.`);
    }
    jestExitCode = await runJest(process.argv.slice(2), testEnv, (runningChild) => { child = runningChild; });
  } finally {
    if (signalExitCode === null) {
      const cleaned = await cleanup();
      await admin.end().catch(() => {});
      if (!cleaned && jestExitCode === 0) jestExitCode = 1;
    }
  }
  process.exitCode = jestExitCode;
}

main().catch(async (error) => {
  console.error(`❌ Isolated test runner failed: ${error.message || error.code || String(error)}`);
  process.exitCode = 1;
});
