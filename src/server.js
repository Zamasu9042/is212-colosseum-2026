require('dotenv').config();
const app = require('./app');
const sequelize = require('./config/db');

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established.');
  } catch (err) {
    console.error('❌ Unable to connect to the database:', err.message);
    console.error('   Did you run `npm run db:init` and set up your .env file?');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 ConnectSphere API listening on http://localhost:${PORT}`);
  });
}

start();
