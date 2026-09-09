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

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'connectsphere',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

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
