require('dotenv').config();
const app = require('./app');
const sequelize = require('./config/db');
const { startHoldExpiryScheduler } = require('./services/holdExpiryService');
const { startEquipmentStatusScheduler } = require('./services/equipmentReservationService');

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

  // Expires tentative holds whose deadline has passed and sends
  // "expiring soon" / "expired" notifications (Week 7). Interval is
  // HOLD_EXPIRY_SWEEP_INTERVAL_MS (default 60s).
  startHoldExpiryScheduler();

  // Clears the 'reserved' flag on equipment whose reservations have all
  // ended (EQUIPMENT_STATUS_SWEEP_INTERVAL_MS, default 60s).
  startEquipmentStatusScheduler();
}

start();
