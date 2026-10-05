// tests/venue.conflicts.test.js
//
// Integration tests for "Venue Schedule Conflict Identification" against
// the real app + test Postgres DB (run `npm run db:reset` first).
// Every run creates its own uniquely named users/venues, so the suite is
// safe to re-run without resetting the database.

const request = require('supertest');
const app = require('../src/app');
const {
  sequelize,
  Role,
  User,
  Venue,
  Event,
  EventRequest,
  VenueHold,
  VenueUnavailability,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const DAY = '2027-03-15';
const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;

async function createUser(roleName) {
  const role = await Role.findOne({ where: { name: roleName } });
  return User.create({
    email: `conflict-${roleName}-${RUN}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Conflict',
    lastName: roleName,
    roleId: role.id,
  });
}

async function login(user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  return res.body.accessToken;
}

function createVenue(name, overrides = {}) {
  return Venue.create({
    name: `Conflict Test ${name} ${RUN}`,
    location: 'Test Wing',
    capacity: 100,
    setupMinutes: 30,
    teardownMinutes: 30,
    status: 'available',
    ...overrides,
  });
}

async function createEvent(organiser, venue, start, end, status = 'confirmed') {
  const eventRequest = await EventRequest.create({
    organiserId: organiser.id,
    eventName: `Conflict source ${RUN}`,
    status: 'approved',
  });
  return Event.create({
    eventRequestId: eventRequest.id,
    venueId: venue.id,
    startDatetime: start,
    endDatetime: end,
    status,
  });
}

describe('Venue Schedule Conflict Identification', () => {
  let staff, coordinator, otherCoordinator, organiser;
  let staffToken, coordinatorToken, otherCoordinatorToken, organiserToken;
  let hall, studio, terrace, closedRoom;
  let bookedEvent;

  const checkConflicts = (token, payload) =>
    request(app).post('/api/venues/conflicts').set('Authorization', `Bearer ${token}`).send(payload);

  beforeAll(async () => {
    staff = await createUser('venue_staff');
    coordinator = await createUser('event_coordinator');
    organiser = await createUser('event_organiser');
    // second coordinator needs a distinct email
    const role = await Role.findOne({ where: { name: 'event_coordinator' } });
    otherCoordinator = await User.create({
      email: `conflict-other-coordinator-${RUN}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Other',
      lastName: 'Coordinator',
      roleId: role.id,
    });

    [staffToken, coordinatorToken, otherCoordinatorToken, organiserToken] = await Promise.all([
      login(staff),
      login(coordinator),
      login(otherCoordinator),
      login(organiser),
    ]);

    hall = await createVenue('Hall'); // 30/30 buffers
    studio = await createVenue('Studio', { setupMinutes: 0, teardownMinutes: 0 });
    terrace = await createVenue('Terrace');
    closedRoom = await createVenue('Closed Room', { status: 'maintenance' });

    // Hall and Studio both booked 10:00-14:00.
    bookedEvent = await createEvent(organiser, hall, at('10:00'), at('14:00'));
    await createEvent(organiser, studio, at('10:00'), at('14:00'));
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('access control and validation', () => {
    test('rejects unauthenticated requests', async () => {
      const res = await request(app).post('/api/venues/conflicts').send({});
      expect(res.status).toBe(401);
    });

    test('rejects roles other than Venue Staff and Event Coordinator', async () => {
      const res = await checkConflicts(organiserToken, {
        venueIds: [hall.id],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.status).toBe(403);
    });

    test.each([
      ['missing venueIds', { startDateTime: at('15:00'), endDateTime: at('16:00') }],
      ['empty venueIds', { venueIds: [], startDateTime: at('15:00'), endDateTime: at('16:00') }],
      ['non-UUID venue id', { venueIds: ['nope'], startDateTime: at('15:00'), endDateTime: at('16:00') }],
      ['missing start', { venueIds: ['00000000-0000-4000-8000-000000000000'], endDateTime: at('16:00') }],
      ['end before start', {
        venueIds: ['00000000-0000-4000-8000-000000000000'],
        startDateTime: at('16:00'),
        endDateTime: at('15:00'),
      }],
    ])('400 for %s', async (_label, payload) => {
      const res = await checkConflicts(staffToken, payload);
      expect(res.status).toBe(400);
    });

    test('404 lists venue ids that do not exist', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      const res = await checkConflicts(staffToken, {
        venueIds: [hall.id, ghost],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain(ghost);
    });
  });

  describe('AC — Setup/turnaround', () => {
    test('a booking inside the existing turnaround buffer is reported as a conflict', async () => {
      const res = await checkConflicts(staffToken, {
        venueIds: [hall.id],
        startDateTime: at('14:30'),
        endDateTime: at('16:00'),
      });
      expect(res.status).toBe(200);
      const [result] = res.body.venues;
      expect(result.hasConflict).toBe(true);
      expect(result.effectiveWindow).toEqual({ start: at('14:00'), end: at('16:30') });
      expect(result.conflicts[0]).toMatchObject({
        type: 'booking',
        eventId: bookedEvent.id,
        effectiveStart: at('09:30'),
        effectiveEnd: at('14:30'),
      });
    });

    test('leaving teardown + setup time free is not a conflict', async () => {
      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.body.hasConflicts).toBe(false);
    });

    test('excludeEventId lets an existing event be re-checked after a change', async () => {
      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id],
        startDateTime: at('10:00'),
        endDateTime: at('15:00'),
        excludeEventId: bookedEvent.id,
      });
      expect(res.body.hasConflicts).toBe(false);
    });
  });

  describe('AC — Tentative holds', () => {
    test('an active hold is reported; releasing it clears the conflict', async () => {
      const created = await request(app)
        .post(`/api/venues/${terrace.id}/holds`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .send({ startDateTime: at('09:00'), endDateTime: at('11:00'), notes: 'Pending client sign-off' });
      expect(created.status).toBe(201);
      expect(created.body.hold).toMatchObject({ status: 'active', isActive: true, heldBy: coordinator.id });
      const holdId = created.body.hold.id;

      const before = await checkConflicts(staffToken, {
        venueIds: [terrace.id],
        startDateTime: at('11:15'), // inside hold turnaround + own setup
        endDateTime: at('12:00'),
      });
      expect(before.body.venues[0].conflicts).toEqual([
        expect.objectContaining({ type: 'tentative_hold', id: holdId }),
      ]);

      // Another coordinator cannot release someone else's hold...
      const forbidden = await request(app)
        .patch(`/api/venues/${terrace.id}/holds/${holdId}/release`)
        .set('Authorization', `Bearer ${otherCoordinatorToken}`);
      expect(forbidden.status).toBe(403);

      // ...but the holder can.
      const released = await request(app)
        .patch(`/api/venues/${terrace.id}/holds/${holdId}/release`)
        .set('Authorization', `Bearer ${coordinatorToken}`);
      expect(released.status).toBe(200);
      expect(released.body.hold).toMatchObject({ status: 'released', isActive: false });

      const again = await request(app)
        .patch(`/api/venues/${terrace.id}/holds/${holdId}/release`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(again.status).toBe(409);

      const after = await checkConflicts(staffToken, {
        venueIds: [terrace.id],
        startDateTime: at('11:15'),
        endDateTime: at('12:00'),
      });
      expect(after.body.hasConflicts).toBe(false);
    });

    test('an expired hold is ignored', async () => {
      await VenueHold.create({
        venueId: terrace.id,
        heldBy: coordinator.id,
        startDatetime: at('18:00'),
        endDatetime: at('20:00'),
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
      const res = await checkConflicts(staffToken, {
        venueIds: [terrace.id],
        startDateTime: at('18:00'),
        endDateTime: at('19:00'),
      });
      expect(res.body.hasConflicts).toBe(false);
    });

    test('placing a hold that conflicts with a booking is refused with 409 and details', async () => {
      const res = await request(app)
        .post(`/api/venues/${hall.id}/holds`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .send({ startDateTime: at('14:00'), endDateTime: at('15:00') });
      expect(res.status).toBe(409);
      expect(res.body.venues[0].conflicts[0]).toMatchObject({ type: 'booking', eventId: bookedEvent.id });
      expect(await VenueHold.count({ where: { venueId: hall.id } })).toBe(0);
    });

    test('a hold for an event does not conflict with that same event', async () => {
      const res = await request(app)
        .post(`/api/venues/${hall.id}/holds`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .send({ startDateTime: at('10:00'), endDateTime: at('14:00'), eventId: bookedEvent.id });
      expect(res.status).toBe(201);
      await VenueHold.destroy({ where: { id: res.body.hold.id } });
    });

    test('concurrent hold requests for the same slot: exactly one succeeds', async () => {
      const venue = await createVenue('Race');
      const attempt = () =>
        request(app)
          .post(`/api/venues/${venue.id}/holds`)
          .set('Authorization', `Bearer ${coordinatorToken}`)
          .send({ startDateTime: at('09:00'), endDateTime: at('10:00') });
      const results = await Promise.all([attempt(), attempt(), attempt()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await VenueHold.count({ where: { venueId: venue.id } })).toBe(1);
    });

    test('a hold may carry a future expiry and blocks the slot until then', async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const created = await request(app)
        .post(`/api/venues/${terrace.id}/holds`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ startDateTime: at('13:00'), endDateTime: at('14:00'), expiresAt });
      expect(created.status).toBe(201);
      expect(created.body.hold.isActive).toBe(true);

      const res = await checkConflicts(coordinatorToken, {
        venueIds: [terrace.id],
        startDateTime: at('13:30'),
        endDateTime: at('15:00'),
      });
      expect(res.body.venues[0].conflicts[0]).toMatchObject({ type: 'tentative_hold', expiresAt });

      // Venue Staff may release any hold.
      const released = await request(app)
        .patch(`/api/venues/${terrace.id}/holds/${created.body.hold.id}/release`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(released.status).toBe(200);
    });

    test('404 when the hold, its venue, or its event does not exist', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      const auth = { Authorization: `Bearer ${coordinatorToken}` };
      const slot = { startDateTime: at('21:00'), endDateTime: at('22:00') };

      expect((await request(app).get(`/api/venues/${ghost}/holds`).set(auth)).status).toBe(404);
      expect((await request(app).post(`/api/venues/${ghost}/holds`).set(auth).send(slot)).status).toBe(404);
      expect(
        (await request(app).post(`/api/venues/${terrace.id}/holds`).set(auth).send({ ...slot, eventId: ghost }))
          .status
      ).toBe(404);
      expect(
        (await request(app).patch(`/api/venues/${terrace.id}/holds/${ghost}/release`).set(auth)).status
      ).toBe(404);
    });

    test('rejects an expiresAt in the past', async () => {
      const res = await request(app)
        .post(`/api/venues/${terrace.id}/holds`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .send({ startDateTime: at('21:00'), endDateTime: at('22:00'), expiresAt: '2020-01-01T00:00:00Z' });
      expect(res.status).toBe(400);
    });

    test('GET lists holds with their computed isActive flag', async () => {
      const res = await request(app)
        .get(`/api/venues/${terrace.id}/holds`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(res.status).toBe(200);
      expect(res.body.holds.length).toBeGreaterThanOrEqual(2);
      expect(res.body.holds.every((h) => h.isActive === false)).toBe(true); // released + expired
    });
  });

  describe('AC — Venue unavailability', () => {
    let periodId;

    test('only Venue Staff can record unavailability', async () => {
      const res = await request(app)
        .post(`/api/venues/${hall.id}/unavailability`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .send({ startDateTime: at('16:00'), endDateTime: at('18:00'), reason: 'Deep clean' });
      expect(res.status).toBe(403);
    });

    test('reason is required', async () => {
      const res = await request(app)
        .post(`/api/venues/${hall.id}/unavailability`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ startDateTime: at('16:00'), endDateTime: at('18:00') });
      expect(res.status).toBe(400);
    });

    test('recording a period returns the existing bookings it now clashes with', async () => {
      const res = await request(app)
        .post(`/api/venues/${hall.id}/unavailability`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ startDateTime: at('14:15'), endDateTime: at('18:00'), reason: 'Deep clean' });
      expect(res.status).toBe(201);
      periodId = res.body.unavailability.id;
      expect(res.body.affected).toEqual([
        expect.objectContaining({ type: 'booking', eventId: bookedEvent.id }),
      ]);
    });

    test('a new booking overlapping the period is reported with its reason', async () => {
      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.body.venues[0].conflicts).toEqual([
        expect.objectContaining({ type: 'unavailability', id: periodId, reason: 'Deep clean' }),
      ]);
    });

    test('venue search reflects unavailability for the requested window', async () => {
      const res = await request(app)
        .get(`/api/venues/${hall.id}`)
        .set('Authorization', `Bearer ${coordinatorToken}`)
        .query({ startDateTime: at('15:00'), endDateTime: at('16:00') });
      expect(res.body.venue.isAvailable).toBe(false);
      expect(res.body.venue.conflictCount).toBe(1);
    });

    test('404 for unavailability on an unknown venue', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      const auth = { Authorization: `Bearer ${staffToken}` };
      expect((await request(app).get(`/api/venues/${ghost}/unavailability`).set(auth)).status).toBe(404);
      const res = await request(app)
        .post(`/api/venues/${ghost}/unavailability`)
        .set(auth)
        .send({ startDateTime: at('16:00'), endDateTime: at('18:00'), reason: 'x' });
      expect(res.status).toBe(404);
    });

    test('a venue marked maintenance is reported as a venue_status conflict', async () => {
      const res = await checkConflicts(staffToken, {
        venueIds: [closedRoom.id],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.body.venues[0].conflicts).toEqual([
        expect.objectContaining({ type: 'venue_status', venueStatus: 'maintenance' }),
      ]);
    });

    test('listing and deleting a period; once deleted it no longer conflicts', async () => {
      const list = await request(app)
        .get(`/api/venues/${hall.id}/unavailability`)
        .set('Authorization', `Bearer ${coordinatorToken}`);
      expect(list.body.unavailability.map((p) => p.id)).toContain(periodId);

      const del = await request(app)
        .delete(`/api/venues/${hall.id}/unavailability/${periodId}`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(del.status).toBe(204);
      expect(await VenueUnavailability.findByPk(periodId)).toBeNull();

      const missing = await request(app)
        .delete(`/api/venues/${hall.id}/unavailability/${periodId}`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(missing.status).toBe(404);

      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id],
        startDateTime: at('15:00'),
        endDateTime: at('16:00'),
      });
      expect(res.body.hasConflicts).toBe(false);
    });
  });

  describe('failure handling', () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const slot = { startDateTime: at('21:00'), endDateTime: at('22:00') };

    afterEach(() => jest.restoreAllMocks());

    test.each([
      ['conflict check', Venue, 'findAll', () =>
        checkConflicts(staffToken, { venueIds: [hall.id], ...slot })],
      ['list holds', VenueHold, 'findAll', () =>
        request(app).get(`/api/venues/${hall.id}/holds`).set('Authorization', `Bearer ${staffToken}`)],
      ['place hold', Venue, 'findByPk', () =>
        request(app).post(`/api/venues/${hall.id}/holds`).set('Authorization', `Bearer ${staffToken}`).send(slot)],
      ['release hold', VenueHold, 'findOne', () =>
        request(app).patch(`/api/venues/${hall.id}/holds/${ghost}/release`).set('Authorization', `Bearer ${staffToken}`)],
      ['list unavailability', VenueUnavailability, 'findAll', () =>
        request(app).get(`/api/venues/${hall.id}/unavailability`).set('Authorization', `Bearer ${staffToken}`)],
      ['record unavailability', VenueUnavailability, 'create', () =>
        request(app)
          .post(`/api/venues/${hall.id}/unavailability`)
          .set('Authorization', `Bearer ${staffToken}`)
          .send({ ...slot, reason: 'x' })],
      ['delete unavailability', VenueUnavailability, 'destroy', () =>
        request(app).delete(`/api/venues/${hall.id}/unavailability/${ghost}`).set('Authorization', `Bearer ${staffToken}`)],
    ])('%s: a database failure returns a generic 500', async (_label, model, method, send) => {
      jest.spyOn(model, method).mockRejectedValueOnce(new Error('db down'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await send();
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error.');
    });
  });

  describe('AC — Multiple venues', () => {
    test('each requested venue gets its own independent result, in request order', async () => {
      // 14:15-15:00: Hall clashes via its 30/30 turnaround; Studio (0/0
      // buffers, same 10:00-14:00 booking) is clear; Terrace is free.
      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id, studio.id, terrace.id, hall.id], // duplicate is collapsed
        startDateTime: at('14:15'),
        endDateTime: at('15:00'),
      });
      expect(res.status).toBe(200);
      expect(res.body.hasConflicts).toBe(true);
      expect(res.body.venues.map((v) => [v.venueId, v.hasConflict])).toEqual([
        [hall.id, true],
        [studio.id, false],
        [terrace.id, false],
      ]);
      expect(res.body.venues[0].venueName).toBe(hall.name);
      expect(res.body.venues[1].effectiveWindow).toEqual({ start: at('14:15'), end: at('15:00') });
    });

    test('hasConflicts is false only when every venue is clear', async () => {
      const res = await checkConflicts(coordinatorToken, {
        venueIds: [hall.id, studio.id, terrace.id],
        startDateTime: at('20:00'),
        endDateTime: at('21:00'),
      });
      expect(res.body.hasConflicts).toBe(false);
      expect(res.body.venues).toHaveLength(3);
    });
  });
});
