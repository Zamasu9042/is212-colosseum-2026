/**
 * DEV ONLY: drops all known tables and re-applies schema.sql + role
 * seed data from scratch. Never run this against a shared/prod DB.
 *
 * Usage: npm run db:reset
 */
require('dotenv').config();
const { Client } = require('pg');
const { execSync } = require('child_process');

const TABLES = [
  'events',
  'event_requests',
  'equipment',
  'venues',
  'refresh_tokens',
  'users',
  'client_organisations',
  'roles',
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Refusing to run db:reset with NODE_ENV=production.');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'connectsphere',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    await client.connect();
    console.log('Dropping existing tables...');
    await client.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE;`);
    console.log('✅ Tables dropped.');
  } catch (err) {
    console.error('❌ Failed to drop tables:', err.message);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }

  console.log('Re-applying schema...');
  execSync('node scripts/init-db.js', { stdio: 'inherit' });
  console.log('Seeding roles...');
  execSync('node scripts/seed-roles.js', { stdio: 'inherit' });
  console.log('✅ Database reset complete.');
}

main();
