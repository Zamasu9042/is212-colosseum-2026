/**
 * DEV ONLY: drops all known tables and re-applies schema.sql + role
 * seed data from scratch. Never run this against a shared/prod DB.
 *
 * Usage: npm run db:reset
 */
require('dotenv').config();
const { Client } = require('pg');
const { execSync } = require('child_process');
const { connectionConfig, isLocalHost } = require('../src/config/databaseConfig');

const TABLES = [
  'event_change_log',
  'event_change_requests',
  'notifications',
  'equipment_reservations',
  'event_equipment_requests',
  'venue_bookings',
  'venue_holds',
  'venue_unavailability',
  'agenda_items',
  'event_programmes',
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
  const config = connectionConfig();
  if (process.env.NODE_ENV === 'production' || config.database !== 'connectsphere' || !isLocalHost(config.host)) {
    console.error('❌ db:reset is restricted to the local connectsphere development database.');
    process.exit(1);
  }

  const client = new Client(config);

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