require('dotenv').config();
const { Client } = require('pg');
const { connectionConfig, isLocalHost, TEST_DATABASE_PREFIX } = require('../src/config/databaseConfig');

function quoteIdentifier(value) {
  if (!value.startsWith(TEST_DATABASE_PREFIX) || !/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Refusing unexpected database name: ${value}`);
  }
  return `"${value}"`;
}

async function main() {
  const source = connectionConfig();
  if (process.env.NODE_ENV === 'production' || !isLocalHost(source.host)) {
    throw new Error('Stale test-database cleanup is restricted to a local PostgreSQL host.');
  }
  const apply = process.argv.includes('--apply');
  const admin = new Client({ ...source, database: process.env.TEST_DB_ADMIN_NAME || 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname', [`${TEST_DATABASE_PREFIX}%`]);
    if (!rows.length) {
      console.log('No temporary test databases found.');
      return;
    }
    for (const { datname } of rows) {
      const { rows: lockRows } = await admin.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [datname]);
      if (!lockRows[0].acquired) {
        console.log(`Skipping active test database (lock held): ${datname}`);
        continue;
      }
      try {
        const { rows: activity } = await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [datname]);
        if (activity[0].count > 0) {
          console.log(`Skipping database with active connections: ${datname}`);
        } else if (apply) {
          await admin.query(`DROP DATABASE ${quoteIdentifier(datname)}`);
          console.log(`Removed stale test database: ${datname}`);
        } else {
          console.log(`Would remove stale test database: ${datname}`);
        }
      } finally {
        await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [datname]);
      }
    }
    if (!apply) console.log('Re-run with --apply to remove only the eligible databases above.');
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(`❌ Test database cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
