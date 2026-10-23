// tests/venue.search.test.js
//
// Integration tests against the real app + a test Postgres database.
// Run `npm run db:reset && npm run db:seed` first, same as any other
// test in this repo, with NODE_ENV=test pointing at a disposable DB.

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Role, User, Venue, Event, EventRequest } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

async function loginAs(email) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Passw0rd1' });
  return res.body.accessToken;
}

// Internal-staff roles can't self-register through the public API (by
// design — see authController), so tests create them directly.
//
// Uses findOrCreate (not create) so this suite is safe to re-run against
// a database that hasn't been freshly reset — e.g. running `npm test`
// twice locally, or a CI job that doesn't tear the DB down between
// builds. A plain `create` here would throw on the unique email
// constraint on any run after the first, failing every test in this
// file via an unhandled beforeAll rejection.
async function createInternalUser(email, roleName) {
  const role = await Role.findOne({ where: { name: roleName } });
  const passwordHash = await hashPassword('Passw0rd1');
  const [user] = await User.findOrCreate({
    where: { email },
    defaults: { email, passwordHash, firstName: 'Test', lastName: roleName, roleId: role.id },
  });
  return user;
}

// Same idempotency reasoning as createInternalUser: findOrCreate keyed
// on name, so re-running this suite never creates duplicate venue rows
// (which would break the exact-match assertions below, e.g. expecting
// exactly one "Auditorium" result).
async function findOrCreateVenue(attrs) {
  const [venue] = await Venue.findOrCreate({ where: { name: attrs.name }, defaults: attrs });
  return venue;
}

describe('Venue Searching and Filtering', () => {
  let coordinatorToken, venueStaffToken;
  let ballroom, meetingRoom, auditorium, maintenanceHall;

  beforeAll(async () => {
    await createInternalUser('search-coordinator@example.com', 'event_coordinator');
    await createInternalUser('availability-venue-staff@example.com', 'venue_staff');
    coordinatorToken = await loginAs('search-coordinator@example.com');
    venueStaffToken = await loginAs('availability-venue-staff@example.com');

    ballroom = await findOrCreateVenue({
      name: 'Search Test Grand Ballroom',
      location: 'Marina Bay',
      capacity: 500,
      venueType: 'Ballroom',
      facilities: ['projector', 'stage', 'wifi'],
      status: 'available',
      setupMinutes: 30,
      teardownMinutes: 30,
    });
    meetingRoom = await findOrCreateVenue({
      name: 'Search Test Small Meeting Room',
      location: 'Orchard',
      capacity: 20,
      venueType: 'Meeting Room',
      facilities: ['whiteboard', 'wifi'],
      status: 'available',
    });
    auditorium = await findOrCreateVenue({
      name: 'Search Test Harbourfront Auditorium',
      location: 'Harbourfront',
      capacity: 300,
      venueType: 'Auditorium',
      facilities: ['projector', 'stage', 'microphone'],
      status: 'available',
      setupMinutes: 30,
      teardownMinutes: 30,
    });
    maintenanceHall = await findOrCreateVenue({
      name: 'Search Test Marina Conference Hall',
      location: 'Marina Bay',
      capacity: 120,
      venueType: 'Conference Room',
      facilities: ['projector', 'wifi'],
      status: 'maintenance',
    });
    // Keep the date-based fixture deterministic when this suite is rerun.
    await auditorium.update({ setupMinutes: 30, teardownMinutes: 30 });

    // Book the auditorium 10:00-14:00 so we can test conflict detection.
    // EventRequest itself has no natural unique key to findOrCreate on,
    // so it's looked up by (organiserId, eventName) first; the Event
    // row IS safely idempotent via findOrCreate on eventRequestId, which
    // has a real DB unique constraint (see schema.sql / Event model).
    const organiser = await createInternalUser('search-organiser@example.com', 'event_organiser');
    const [eventRequest] = await EventRequest.findOrCreate({
      where: { organiserId: organiser.id, eventName: 'Search Test Conflict Source' },
      defaults: { organiserId: organiser.id, eventName: 'Search Test Conflict Source', status: 'approved' },
    });
    await Event.findOrCreate({
      where: { eventRequestId: eventRequest.id },
      defaults: {
        eventRequestId: eventRequest.id,
        venueId: auditorium.id,
        startDatetime: new Date('2026-10-01T10:00:00Z'),
        endDatetime: new Date('2026-10-01T14:00:00Z'),
        status: 'confirmed',
      },
    });

    const [tentativeRequest] = await EventRequest.findOrCreate({
      where: { organiserId: organiser.id, eventName: 'Search Test Tentative Hold Source' },
      defaults: { organiserId: organiser.id, eventName: 'Search Test Tentative Hold Source', status: 'approved' },
    });
    await Event.findOrCreate({
      where: { eventRequestId: tentativeRequest.id },
      defaults: {
        eventRequestId: tentativeRequest.id,
        venueId: ballroom.id,
        startDatetime: new Date('2026-10-01T16:00:00Z'),
        endDatetime: new Date('2026-10-01T17:00:00Z'),
        status: 'planning',
      },
    });

    const [expiredRequest] = await EventRequest.findOrCreate({
      where: { organiserId: organiser.id, eventName: 'Search Test Expired Hold Source' },
      defaults: { organiserId: organiser.id, eventName: 'Search Test Expired Hold Source', status: 'approved' },
    });
    await Event.findOrCreate({
      where: { eventRequestId: expiredRequest.id },
      defaults: {
        eventRequestId: expiredRequest.id,
        venueId: meetingRoom.id,
        startDatetime: new Date('2026-10-01T12:00:00Z'),
        endDatetime: new Date('2026-10-01T13:00:00Z'),
        status: 'cancelled',
      },
    });

    const [existingTentativeRequest] = await EventRequest.findOrCreate({
      where: { organiserId: organiser.id, eventName: 'Search Test Existing Timing Conflict Source' },
      defaults: { organiserId: organiser.id, eventName: 'Search Test Existing Timing Conflict Source', status: 'approved' },
    });
    await Event.findOrCreate({
      where: { eventRequestId: existingTentativeRequest.id },
      defaults: {
        eventRequestId: existingTentativeRequest.id,
        venueId: auditorium.id,
        startDatetime: new Date('2026-10-01T15:00:00Z'),
        endDatetime: new Date('2026-10-01T16:00:00Z'),
        status: 'planning',
      },
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('unauthenticated requests are rejected', async () => {
    const res = await request(app).get('/api/venues');
    expect(res.status).toBe(401);
  });

  test('AC1: can search venues by name', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ search: 'Grand Ballroom' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const names = res.body.venues.map((v) => v.name);
    expect(names).toContain(ballroom.name);
    expect(names).not.toContain(meetingRoom.name);
  });

  test('AC1: can search venues by location', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ search: 'Marina Bay' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const names = res.body.venues.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining([ballroom.name, maintenanceHall.name]));
  });

  test('AC2: can filter by minimum capacity', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ minCapacity: 200, search: 'Search Test' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    res.body.venues.forEach((v) => expect(v.capacity).toBeGreaterThanOrEqual(200));
    const names = res.body.venues.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining([ballroom.name, auditorium.name]));
    expect(names).not.toContain(meetingRoom.name);
  });

  test('AC2: can filter by venue type', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ venueType: 'Auditorium' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.venues.map((v) => v.name)).toEqual([auditorium.name]);
    expect(res.body.venues[0].venueType).toBe('Auditorium');
  });

  test('AC2: can filter by required facilities (must have ALL requested)', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ facilities: 'projector,stage', search: 'Search Test' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const names = res.body.venues.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining([ballroom.name, auditorium.name]));
    expect(names).not.toContain(meetingRoom.name); // no stage
    expect(names).not.toContain(maintenanceHall.name); // no stage
  });

  test('AC2: can filter by availability=available (excludes maintenance venues)', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ availability: 'available', search: 'Search Test' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const names = res.body.venues.map((v) => v.name);
    expect(names).not.toContain(maintenanceHall.name);
    res.body.venues.forEach((v) => expect(v.isAvailable).toBe(true));
  });

  test('AC2: availability filter also accounts for conflicting bookings within a proposed window', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({
        availability: 'available',
        search: 'Search Test',
        startDateTime: '2026-10-01T11:00:00Z',
        endDateTime: '2026-10-01T12:00:00Z',
      })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const names = res.body.venues.map((v) => v.name);
    expect(names).not.toContain(auditorium.name); // booked during this window
    expect(names).toContain(ballroom.name);
  });

  test('AC2/AC3: availability check respects the venue setup/teardown buffer', async () => {
    // Event runs 10:00-14:00 with a 30-minute teardown buffer -> occupied
    // until 14:30, so a 14:15-14:45 request should conflict.
    const conflicting = await request(app)
      .get(`/api/venues/${auditorium.id}`)
      .query({ startDateTime: '2026-10-01T14:15:00Z', endDateTime: '2026-10-01T14:45:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(conflicting.body.venue.isAvailable).toBe(false);

    // Clear of the buffer entirely.
    const free = await request(app)
      .get(`/api/venues/${auditorium.id}`)
      .query({ startDateTime: '2026-10-01T17:00:00Z', endDateTime: '2026-10-01T18:00:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(free.body.venue.isAvailable).toBe(true);
  });

  test('availability calendar filters by venue and date and returns buffered confirmed slots', async () => {
    const res = await request(app)
      .get('/api/venues/availability')
      .query({ venueId: auditorium.id, date: '2026-10-01' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1 });
    expect(res.body.availability[0].venue.id).toBe(auditorium.id);
    expect(res.body.availability[0].slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'confirmed_booking',
        startDateTime: '2026-10-01T09:30:00.000Z',
        endDateTime: '2026-10-01T14:30:00.000Z',
        isAvailable: false,
      }),
    ]));
  });

  test('availability calendar exposes every display state and makes only requestable slots available', async () => {
    const res = await request(app)
      .get('/api/venues/availability')
      .query({ venueId: [ballroom.id, meetingRoom.id, auditorium.id, maintenanceHall.id].join(','), date: '2026-10-01' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.states).toEqual(expect.arrayContaining([
      'available',
      'tentative_hold',
      'confirmed_booking',
      'temporarily_unavailable',
      'expired_hold',
    ]));

    const slotsFor = (id) => res.body.availability.find((entry) => entry.venue.id === id).slots;
    const tentative = slotsFor(ballroom.id).find((slot) => slot.state === 'tentative_hold');
    expect(tentative).toMatchObject({
      displayState: 'Tentative Hold',
      startDateTime: '2026-10-01T15:30:00.000Z',
      endDateTime: '2026-10-01T17:30:00.000Z',
      isAvailable: false,
    });
    expect(slotsFor(ballroom.id).find((slot) => slot.state === 'available')).toMatchObject({ isAvailable: true });

    expect(slotsFor(auditorium.id).find((slot) => slot.state === 'confirmed_booking')).toMatchObject({
      displayState: 'Confirmed Booking',
      isAvailable: false,
    });
    expect(slotsFor(meetingRoom.id).find((slot) => slot.state === 'expired_hold')).toMatchObject({
      displayState: 'Expired Hold',
      isAvailable: true,
    });
    expect(slotsFor(maintenanceHall.id)).toEqual([expect.objectContaining({
      state: 'temporarily_unavailable',
      displayState: 'Temporarily Unavailable',
      isAvailable: false,
    })]);
  });

  test('availability calendar requires a date or complete explicit range', async () => {
    const missingRange = await request(app)
      .get('/api/venues/availability')
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(missingRange.status).toBe(400);

    const incompleteRange = await request(app)
      .get('/api/venues/availability')
      .query({ startDateTime: '2026-10-01T10:00:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(incompleteRange.status).toBe(400);
  });

  test('venue staff can store setup and turnaround times when creating a venue', async () => {
    const res = await request(app)
      .post('/api/venues')
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({
        name: 'Search Test Configured Timing Venue',
        location: 'Bugis',
        capacity: 50,
        setupMinutes: 30,
        turnaroundMinutes: 45,
      });

    expect(res.status).toBe(201);
    expect(res.body.venue).toMatchObject({
      setupMinutes: 30,
      teardownMinutes: 45,
      turnaroundMinutes: 45,
    });
  });

  test('only venue staff can configure timing, and conflicting timing aliases are rejected', async () => {
    const forbidden = await request(app)
      .patch(`/api/venues/${ballroom.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ setupMinutes: 20, turnaroundMinutes: 40 });
    expect(forbidden.status).toBe(403);

    const invalid = await request(app)
      .patch(`/api/venues/${ballroom.id}`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ setupMinutes: -1, turnaroundMinutes: 40 });
    expect(invalid.status).toBe(400);

    const mismatchedAliases = await request(app)
      .patch(`/api/venues/${ballroom.id}`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ teardownMinutes: 30, turnaroundMinutes: 45 });
    expect(mismatchedAliases.status).toBe(400);
  });

  test('changed turnaround flags existing tentative and confirmed bookings without deleting either', async () => {
    const eventsBefore = await Event.findAll({ where: { venueId: auditorium.id } });
    const res = await request(app)
      .patch(`/api/venues/${auditorium.id}`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ setupMinutes: 30, turnaroundMinutes: 45 });

    expect(res.status).toBe(200);
    expect(res.body.venue).toMatchObject({ setupMinutes: 30, teardownMinutes: 45, turnaroundMinutes: 45 });
    expect(res.body.hasConflicts).toBe(true);
    const blockingEventIds = eventsBefore
      .filter((event) => ['confirmed', 'planning'].includes(event.status))
      .map((event) => event.id);
    expect(res.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventIds: expect.arrayContaining(blockingEventIds) }),
    ]));
    expect(await Event.count({ where: { venueId: auditorium.id } })).toBe(eventsBefore.length);
  });

  test('AC3: results include key venue details (location, capacity, availability, facilities)', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ search: 'Grand Ballroom' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.body.venues[0]).toMatchObject({
      name: ballroom.name,
      location: 'Marina Bay',
      capacity: 500,
      facilities: expect.arrayContaining(['projector', 'stage', 'wifi']),
      isAvailable: true,
    });
  });

  test('AC4: can sort results by capacity', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ search: 'Search Test', sortBy: 'capacity', sortOrder: 'desc' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    const capacities = res.body.venues.map((v) => v.capacity);
    const sorted = [...capacities].sort((a, b) => b - a);
    expect(capacities).toEqual(sorted);
  });

  test('AC4: can sort results by availability', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ search: 'Search Test', sortBy: 'availability', sortOrder: 'asc' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    const availabilities = res.body.venues.map((v) => v.isAvailable);
    // "asc" => available (true) venues first.
    const firstFalseIndex = availabilities.indexOf(false);
    if (firstFalseIndex !== -1) {
      expect(availabilities.slice(0, firstFalseIndex).every(Boolean)).toBe(true);
    }
  });

  test('AC5: can select a single venue from search results for further review', async () => {
    const res = await request(app)
      .get(`/api/venues/${ballroom.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.venue).toMatchObject({ id: ballroom.id, name: ballroom.name });
  });

  test('AC5: selecting a non-existent venue returns 404', async () => {
    const res = await request(app)
      .get('/api/venues/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(404);
  });

  test('AC6: an informative message is returned when no venues match', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ minCapacity: 999999 })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
    expect(res.body.message).toMatch(/no venues match/i);
  });

  test('rejects startDateTime without a matching endDateTime', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ startDateTime: '2026-10-01T09:00:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(400);
  });

  test('rejects an endDateTime that is not after startDateTime', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ startDateTime: '2026-10-01T10:00:00Z', endDateTime: '2026-10-01T09:00:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(400);
  });

  test('rejects an invalid minCapacity value', async () => {
    const res = await request(app)
      .get('/api/venues')
      .query({ minCapacity: 'lots' })
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(400);
  });
});
