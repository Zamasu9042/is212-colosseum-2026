/**
 * DEV/DEMO ONLY: loads a small, realistic data set so every role has
 * something to do in the web GUI. One account per role, all with the
 * password Passw0rd1. Dates are relative to today so events stay upcoming.
 *
 * Idempotent: if the demo organiser already exists, nothing is changed.
 * Run `npm run db:reset && npm run db:demo` to start over.
 *
 * Usage: npm run db:demo   (after db:init and db:seed)
 */
require('dotenv').config();
const {
  sequelize, Role, User, ClientOrganisation, Venue, Equipment, EventRequest, Event,
  VenueBooking, EventEquipmentRequest, EquipmentReservation, Notification,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');

// Keep the console readable even when NODE_ENV=development enables SQL logging.
sequelize.options.logging = false;

const PASSWORD = 'Passw0rd1';
const DOMAIN = 'demo.connectsphere.sg';

// Times are written in Singapore time (UTC+8) and stored as UTC.
function sgt(daysFromToday, hh, mm = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  d.setUTCHours(hh - 8, mm, 0, 0);
  return d;
}

const ACCOUNTS = [
  ['organiser', 'event_organiser', 'Jane', 'Tan'],
  ['coordinator', 'event_coordinator', 'Marcus', 'Lim'],
  ['coordinator2', 'event_coordinator', 'Priya', 'Nair'],
  ['lead', 'event_coordinator_lead', 'Sarah', 'Wong'],
  ['venue', 'venue_staff', 'Ahmad', 'Rahman'],
  ['tech', 'technical_support_staff', 'Kevin', 'Ong'],
  ['safety', 'safety_officer', 'Grace', 'Lee'],
  ['attendee', 'attendee', 'Daniel', 'Koh'],
];

const FULL_REQUEST = {
  description: 'Full-day programme with keynote, breakouts and lunch.',
  purpose: 'Align regional leadership on next year’s priorities.',
  category: 'conference',
  venueRequirements: 'Main hall plus two breakout rooms',
  requestedLayout: 'theatre',
  layout: 'theatre',
  accessibilityRequirements: 'Wheelchair access, hearing loop',
  facilityRequirements: 'projector, wifi, stage',
  setupRequirements: 'Stage and registration desk set up 1 hour before',
  equipmentRequirements: '2 projectors, wireless mics, PA system',
  registrationSetup: 'Invite-only registration via email link',
  registrationRequired: true,
};

async function main() {
  await sequelize.authenticate();

  if (await User.findOne({ where: { email: `organiser@${DOMAIN}` } })) {
    console.log('✓ Demo data already present. Run `npm run db:reset && npm run db:demo` to reload it.');
    return;
  }

  await sequelize.transaction(async (transaction) => {
    const t = { transaction };
    const roles = Object.fromEntries((await Role.findAll(t)).map((r) => [r.name, r.id]));
    const missing = ACCOUNTS.map((a) => a[1]).filter((r) => !roles[r]);
    if (missing.length) throw new Error(`Roles missing (${missing.join(', ')}). Run npm run db:seed first.`);

    const org = await ClientOrganisation.create(
      { name: 'Acme Asia Pte Ltd', contactEmail: `events@acme.example`, contactPhone: '+65 6123 4567' }, t
    );
    const passwordHash = await hashPassword(PASSWORD);
    const u = {};
    for (const [key, role, firstName, lastName] of ACCOUNTS) {
      u[key] = await User.create({
        email: `${key}@${DOMAIN}`, passwordHash, firstName, lastName, roleId: roles[role],
        organisationId: role === 'event_organiser' ? org.id : null,
        department: ['event_organiser', 'attendee'].includes(role) ? null : 'Operations',
      }, t);
    }

    // --- Venues ---
    const venue = (o) => Venue.create({ status: 'available', setupMinutes: 30, teardownMinutes: 30, ...o }, t);
    const grandHall = await venue({
      name: 'Marina Grand Hall', location: 'Marina Bay', capacity: 400, venueType: 'Ballroom',
      supportedLayouts: ['theatre', 'banquet', 'classroom'], facilities: ['projector', 'wifi', 'stage', 'pa_system'],
      accessibilityFeatures: ['wheelchair_access', 'hearing_loop'], setupMinutes: 60, teardownMinutes: 60,
    });
    const harbour = await venue({
      name: 'Harbourfront Seminar Room', location: 'HarbourFront', capacity: 80, venueType: 'Conference Room',
      supportedLayouts: ['classroom', 'boardroom'], facilities: ['projector', 'wifi', 'whiteboard'],
      accessibilityFeatures: ['wheelchair_access'],
    });
    await venue({
      name: 'Jurong Innovation Lab', location: 'Jurong East', capacity: 40, venueType: 'Meeting Room',
      supportedLayouts: ['boardroom', 'classroom'], facilities: ['wifi', 'tv_screen'], accessibilityFeatures: [],
    });
    await venue({
      name: 'Changi Exhibition Pavilion', location: 'Changi', capacity: 600, venueType: 'Exhibition Hall',
      supportedLayouts: ['exhibition', 'banquet'], facilities: ['wifi', 'pa_system', 'loading_bay'],
      accessibilityFeatures: ['wheelchair_access'], status: 'maintenance',
    });

    // --- Equipment (SCRUM-22: a mix of statuses) ---
    const item = (o) => Equipment.create({ quantityTotal: 1, quantityAvailable: 1, location: 'Main Store, Marina Bay', status: 'available', ...o }, t);
    const projA = await item({ name: 'Epson 4K Projector #1', type: 'Projector', description: '5,000 lumens, HDMI/USB-C' });
    const projB = await item({ name: 'Epson 4K Projector #2', type: 'Projector', description: '5,000 lumens, HDMI/USB-C' });
    await item({ name: 'Epson 4K Projector #3', type: 'Projector', description: 'Lamp being replaced', status: 'in_repair' });
    const mics = await item({ name: 'Shure Wireless Mic Set', type: 'Audio', description: 'Handheld + lapel', quantityTotal: 6, quantityAvailable: 6 });
    const pa = await item({ name: 'Bose PA System', type: 'Audio', description: '2 speakers + mixer' });
    await item({ name: '85" LED Display', type: 'Display', description: 'Cracked panel — written off', status: 'unavailable' });
    await item({ name: 'Presenter Laptops', type: 'Computing', description: 'Windows 11, PowerPoint', quantityTotal: 8, quantityAvailable: 8, location: 'IT Store, HarbourFront' });
    await item({ name: 'Livestream Camera Kit', type: 'Video', description: '2 cameras + encoder', location: 'IT Store, HarbourFront' });

    // --- Event requests at each stage ---
    const req = (o) => EventRequest.create({ organiserId: u.organiser.id, organisationId: org.id, ...o }, t);
    await req({ eventName: 'Q1 Town Hall', description: 'Quarterly all-hands', status: 'draft', expectedAttendance: 150 });
    await req({
      ...FULL_REQUEST, eventName: 'Partner Networking Night', category: 'networking',
      preferredStart: sgt(21, 18), preferredEnd: sgt(21, 22), expectedAttendance: 120,
      status: 'submitted', submittedAt: new Date(),
    });
    await req({
      ...FULL_REQUEST, eventName: 'Data Science Workshop', category: 'workshop', requestedLayout: 'classroom', layout: 'classroom',
      preferredStart: sgt(28, 9), preferredEnd: sgt(28, 13), expectedAttendance: 40,
      status: 'submitted', submittedAt: new Date(), assignedCoordinatorId: u.coordinator.id,
    });

    // Approved events (Event rows) for equipment work.
    const approved = async (name, start, end, extra = {}) => {
      const r = await req({
        ...FULL_REQUEST, eventName: name, preferredStart: start, preferredEnd: end,
        expectedAttendance: extra.attendance || 200, status: 'approved', submittedAt: new Date(),
        assignedCoordinatorId: u.coordinator.id, reviewedAt: new Date(), reviewedBy: u.coordinator.id,
      });
      return Event.create({
        eventRequestId: r.id, coordinatorId: u.coordinator.id, venueId: extra.venueId || null,
        startDatetime: start, endDatetime: end, status: extra.status || 'planning',
      }, t);
    };
    const summit = await approved('Annual Leadership Summit', sgt(14, 9), sgt(14, 17), { attendance: 250 });
    const gala = await approved('Product Launch Gala', sgt(14, 16), sgt(14, 21), { status: 'confirmed', venueId: grandHall.id });
    const training = await approved('Customer Training Day', sgt(14, 17), sgt(14, 19), { attendance: 60, venueId: harbour.id });

    await VenueBooking.create({
      eventId: summit.id, venueId: grandHall.id, requestedBy: u.coordinator.id,
      startDatetime: summit.startDatetime, endDatetime: summit.endDatetime, expectedAttendance: 250,
      requirements: 'Theatre layout, stage, registration desk', status: 'pending',
    }, t);

    // SCRUM-24: equipment needs for the summit; partially allocated.
    const line = (eventId, o) => EventEquipmentRequest.create({ eventId, requestedBy: u.coordinator.id, ...o }, t);
    const sProj = await line(summit.id, { equipmentType: 'Projector', quantityRequested: 2, technicalRequirements: 'HDMI to stage' });
    await line(summit.id, { equipmentType: 'Audio', equipmentId: mics.id, quantityRequested: 4, technicalRequirements: '2 handheld, 2 lapel' });
    await line(summit.id, { equipmentType: 'Audio', equipmentId: pa.id, quantityRequested: 1 });
    await line(gala.id, { equipmentType: 'Projector', quantityRequested: 1 });

    // SCRUM-21: one live reservation so Projector #1 shows as reserved.
    await EquipmentReservation.create({
      eventId: summit.id, equipmentId: projA.id, equipmentRequestId: sProj.id, quantity: 1,
      startDatetime: summit.startDatetime, endDatetime: summit.endDatetime,
      organiserName: 'Jane Tan', status: 'active', reservedBy: u.tech.id, reservedAt: new Date(),
    }, t);
    await projA.update({ status: 'reserved' }, t);
    void projB; void training;

    await Notification.create({
      userId: u.coordinator.id, type: 'event_coordinator_assigned', eventId: null,
      message: 'You have been assigned to coordinate event request: Data Science Workshop.',
    }, t);
  });

  console.log('✅ Demo data loaded. Sign in at http://localhost:' + (process.env.PORT || 4000) + ' with any of:');
  for (const [key, role] of ACCOUNTS) console.log(`   ${`${key}@${DOMAIN}`.padEnd(38)} ${role}`);
  console.log(`   Password for every account: ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error('❌ Demo seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
