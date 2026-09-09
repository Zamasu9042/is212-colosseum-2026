/**
 * Seeds the `roles` table with the 5 roles defined in the customer
 * briefing. Idempotent — uses findOrCreate so it's safe to re-run.
 *
 * Usage: npm run db:seed
 */
require('dotenv').config();
const { sequelize, Role } = require('../src/models');

const ROLES = [
  {
    name: 'event_organiser',
    displayName: 'Event Organiser',
    description:
      'External client representative who has an event to organise and communicates requirements to ConnectSphere.',
  },
  {
    name: 'event_coordinator',
    displayName: 'Event Coordinator',
    description:
      'Internal staff assigned to coordinate the overall planning of an event and act as the main point of contact.',
  },
  {
    name: 'venue_staff',
    displayName: 'Venue Staff',
    description:
      'Internal staff responsible for venue information, availability, booking decisions, and physical preparation.',
  },
  {
    name: 'technical_support_staff',
    displayName: 'Technical Support Staff',
    description:
      'Internal staff responsible for equipment, technical requirements, reservations, and on-site technical support.',
  },
  {
    name: 'attendee',
    displayName: 'Attendee',
    description: 'External participant who registers for and attends an event.',
  },
];

async function main() {
  try {
    await sequelize.authenticate();
    for (const role of ROLES) {
      const [record, created] = await Role.findOrCreate({
        where: { name: role.name },
        defaults: role,
      });
      console.log(`${created ? '➕ Created' : '✓ Exists '} role: ${record.name}`);
    }
    console.log('✅ Role seeding complete.');
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
