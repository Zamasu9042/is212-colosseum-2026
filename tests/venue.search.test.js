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
async function createInternalUser(email, roleName) {
  const role = await Role.findOne({ where: { name: roleName } });
  const passwordHash = await hashPassword('Passw0rd1');
  return User.create({
    email,
    passwordHash,
    firstName: 'Test',
    lastName: roleName,
    roleId: role.id,
  });
}

describe('Venue Searching and Filtering', () => {
  let coordinatorToken;
  let ballroom, meetingRoom, auditorium, maintenanceHall;

  beforeAll(async () => {
    await createInternalUser('search-coordinator@example.com', 'event_coordinator');
    coordinatorToken = await loginAs('search-coordinator@example.com');

    ballroom = await Venue.create({
      name: 'Search Test Grand Ballroom',
      location: 'Marina Bay',
      capacity: 500,
      venueType: 'Ballroom',
      facilities: ['projector', 'stage', 'wifi'],
      status: 'available',
      setupMinutes: 30,
      teardownMinutes: 30,
    });
    meetingRoom = await Venue.create({
      name: 'Search Test Small Meeting Room',
      location: 'Orchard',
      capacity: 20,
      venueType: 'Meeting Room',
      facilities: ['whiteboard', 'wifi'],
      status: 'available',
    });
    auditorium = await Venue.create({
      name: 'Search Test Harbourfront Auditorium',
      location: 'Harbourfront',
      capacity: 300,
      venueType: 'Auditorium',
      facilities: ['projector', 'stage', 'microphone'],
      status: 'available',
      setupMinutes: 30,
      teardownMinutes: 30,
    });
    maintenanceHall = await Venue.create({
      name: 'Search Test Marina Conference Hall',
      location: 'Marina Bay',
      capacity: 120,
      venueType: 'Conference Room',
      facilities: ['projector', 'wifi'],
      status: 'maintenance',
    });

    // Book the auditorium 10:00-14:00 so we can test conflict detection.
    const organiser = await createInternalUser('search-organiser@example.com', 'event_organiser');
    const eventRequest = await EventRequest.create({
      organiserId: organiser.id,
      eventName: 'Search Test Conflict Source',
      status: 'approved',
    });
    await Event.create({
      eventRequestId: eventRequest.id,
      venueId: auditorium.id,
      startDatetime: new Date('2026-10-01T10:00:00Z'),
      endDatetime: new Date('2026-10-01T14:00:00Z'),
      status: 'confirmed',
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
      .query({ startDateTime: '2026-10-01T15:00:00Z', endDateTime: '2026-10-01T16:00:00Z' })
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(free.body.venue.isAvailable).toBe(true);
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
