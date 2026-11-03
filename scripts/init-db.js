/**
 * Deploys the relational schema (src/migrations/schema.sql) to the
 * configured PostgreSQL database. Idempotent: safe to re-run since
 * the SQL uses CREATE TABLE IF NOT EXISTS.
 *
 * Usage: npm run db:init
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionConfig } = require('../src/config/databaseConfig');

async function main() {
  const client = new Client(connectionConfig());

  const schemaPath = path.join(__dirname, '..', 'src', 'migrations', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    await client.connect();
    console.log('Connected to database. Applying schema...');
    await client.query(sql);
    console.log('✅ Schema applied successfully.');
  } catch (err) {
    console.error('❌ Failed to apply schema:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
