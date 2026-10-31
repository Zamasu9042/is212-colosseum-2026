require('dotenv').config();
const { Client } = require('pg');
const { connectionConfig, TEST_DATABASE_PREFIX } = require('../src/config/databaseConfig');

async function main() {
  const config = connectionConfig();
  if (process.env.NODE_ENV !== 'test' || !config.database.startsWith(TEST_DATABASE_PREFIX)) {
    throw new Error('Test database verification requires NODE_ENV=test and a generated test database.');
  }

  const client = new Client(config);
  try {
    await client.connect();
    const { rows } = await client.query('SELECT current_database() AS database');
    if (rows[0].database !== process.env.TEST_DATABASE_NAME) {
      throw new Error(`Connected to ${rows[0].database}, expected ${process.env.TEST_DATABASE_NAME}.`);
    }
    console.log(`✓ Verified isolated test database: ${rows[0].database}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`❌ Test database verification failed: ${error.message}`);
  process.exitCode = 1;
});
