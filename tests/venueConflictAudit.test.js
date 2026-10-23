// tests/venueConflictAudit.test.js
//
// Integration tests for "Extend Venue Conflict Detection for Updated
// Booking Rules" (Week 7) against the real app + test Postgres DB.
// The rules for NEW requests (setup/turnaround, active holds,
// unavailability, multiple venues) are covered in venue.conflicts.test.js
// and venueBooking.test.js; this suite covers the end-to-end rules for
// requests plus the new AC: EXISTING bookings that become conflicting
// are flagged and preserved, never deleted.

const request = require('supertest');
const app = require('../src/app');
const {
  sequelize, Role, User, Venue, Event, EventRequest, VenueBooking, VenueHold, Notification, ROLE_NAMES,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const DAY = '2027-06-10';
const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;

async function createUser(roleName, label) {
  const [role] = await Role.findOrCreate({ where: { name: roleName }, defaults: { name: roleName, displayName: roleName } });
  return User.create({
    email: `audit-${label}-${RUN}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Audit',
    lastName: label,
    roleId: role.id,
  });
}

async function login(user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  return res.body.accessToken;
}

function createVenue(label, overrides = {}) {
  return Venue.create({
    name: `Audit ${label} ${RUN}`,
    location: 'Audit Wing',
    capacity: 300,
    setupMinutes: 0,
    teardownMinutes: 0,
    status: 'available',
    ...overrides,
  });
}

async function createEvent(organiser, coordinator, name, extra = {}) {
  const er = await EventRequest.create({
    organiserId: organiser.id,
    eventName: `${name} ${RUN}`,
    expectedAttendance: 40,
    status: 'approved',
  });
  return Event.create({
    eventRequestId: er.id,
    coordinatorId: coordinator.id,
    startDatetime: at('08:00'),
    endDatetime: at('20:00'),
    status: 'planning',
    ...extra,
  });
}

// Inserts a booking directly, as if it was approved under the OLD rules.
function legacyBooking(event, venue, requester, start, end, status = 'approved') {
  return VenueBooking.create({
    eventId: event.id,
    venueId: venue.id,
    requestedBy: requester.id,
    startDatetime: start,
    endDatetime: end,
    expectedAttendance: 40,
    status,
  });
}

describe('Extend Venue Conflict Detection for Updated Booking Rules', () => {
  let staff, coordA, coordB, organiser;
  let tStaff, tCoordA, tCoordB;
  let eventA, eventB;

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const patchVenue = (venue, body) => request(app).patch(`/api/venues/${venue.id}`).set(auth(tStaff)).send(body);
  const runAudit = (body = {}, token = tStaff) =>
    request(app).post('/api/venues/conflicts/audit').set(auth(token)).send(body);

  beforeAll(async () => {
    staff = await createUser(ROLE_NAMES.VENUE_STAFF, 'staff');
    coordA = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord-a');
    coordB = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord-b');
    organiser = await createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    [tStaff, tCoordA, tCoordB] = await Promise.all([login(staff), login(coordA), login(coordB)]);
    eventA = await createEvent(organiser, coordA, 'Audit Event A');
    eventB = await createEvent(organiser, coordB, 'Audit Event B');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // -----------------------------------------------------------------
  describe('new booking requests use every updated rule', () => {
    test('setup time before and turnaround time after are both enforced', async () => {
      const venue = await createVenue('Buffers', { setupMinutes: 45, teardownMinutes: 15 });
      await legacyBooking(eventA, venue, coordA, at('10:00'), at('12:00'));
      const book = (start, end) =>
        request(app)
          .post(`/api/events/${eventB.id}/venue-bookings`)
          .set(auth(tCoordB))
          .send({ venueId: venue.id, startDatetime: start, endDatetime: end });

      // Ends 09:00; its 15-min turnaround ends 09:15, exactly when A's 45-min setup starts. Touching = OK.
      expect((await book(at('08:00'), at('09:00'))).status).toBe(201);
      // Starts 12:30: A's turnaround runs to 12:15, B's own setup starts 11:45 -> clash.
      const clash = await book(at('12:30'), at('13:30'));
      expect(clash.status).toBe(422);
      expect(clash.body.failures[0].check).toBe('conflict');
      // 13:00 start: setup from 12:15, exactly when A's turnaround ends -> OK.
      expect((await book(at('13:00'), at('14:00'))).status).toBe(201);
    });

    test('a temporary unavailability period blocks only the affected times', async () => {
      const venue = await createVenue('Unavailable');
      const period = await request(app)
        .post(`/api/venues/${venue.id}/unavailability`)
        .set(auth(tStaff))
        .send({ startDateTime: at('12:00'), endDateTime: at('14:00'), reason: 'Ceiling repair', reasonCategory: 'maintenance' });
      expect(period.status).toBe(201);

      const book = (start, end) =>
        request(app)
          .post(`/api/events/${eventB.id}/venue-bookings`)
          .set(auth(tCoordB))
          .send({ venueId: venue.id, startDatetime: start, endDatetime: end });
      const blocked = await book(at('13:00'), at('15:00'));
      expect(blocked.status).toBe(422);
      expect(blocked.body.failures[0]).toMatchObject({ check: 'availability' });
      expect((await book(at('14:00'), at('16:00'))).status).toBe(201);
    });

    test('for a multi-venue event each venue is checked independently', async () => {
      const busy = await createVenue('Multi Busy');
      const free = await createVenue('Multi Free');
      await legacyBooking(eventA, busy, coordA, at('10:00'), at('12:00'));

      const res = await request(app)
        .post('/api/venues/conflicts')
        .set(auth(tCoordB))
        .send({ venueIds: [busy.id, free.id], startDateTime: at('11:00'), endDateTime: at('13:00') });
      expect(res.body.venues.map((v) => [v.venueId, v.hasConflict])).toEqual([[busy.id, true], [free.id, false]]);

      const book = (venue) =>
        request(app)
          .post(`/api/events/${eventB.id}/venue-bookings`)
          .set(auth(tCoordB))
          .send({ venueId: venue.id, startDatetime: at('11:00'), endDatetime: at('13:00') });
      expect((await book(busy)).status).toBe(422);
      expect((await book(free)).status).toBe(201); // one venue failing does not block the other
    });
  });

  // -----------------------------------------------------------------
  describe('existing bookings are flagged and preserved', () => {
    let hall, first, second, untouched;

    beforeAll(async () => {
      // Two back-to-back bookings approved when the hall had no buffers.
      hall = await createVenue('Hall');
      first = await legacyBooking(eventA, hall, coordA, at('09:00'), at('12:00'));
      second = await legacyBooking(eventB, hall, coordB, at('12:00'), at('15:00'));
      untouched = await legacyBooking(eventB, hall, coordB, at('17:00'), at('18:00'));
    });

    test('raising setup/turnaround time flags the bookings it now makes conflicting', async () => {
      const res = await patchVenue(hall, { setupMinutes: 30, teardownMinutes: 30 });
      expect(res.status).toBe(200);
      expect(res.body.venue.setupMinutes).toBe(30);
      expect(res.body.conflictAudit.totals).toMatchObject({ checked: 3, flagged: 2, newlyFlagged: 2 });

      const flaggedIds = res.body.conflictAudit.venues[0].flagged.map((f) => f.id).sort();
      expect(flaggedIds).toEqual([first.id, second.id].sort());
      expect(res.body.conflictAudit.venues[0].flagged[0].conflicts[0].type).toBe('booking');
    });

    test('flagged bookings are preserved exactly as they were', async () => {
      for (const original of [first, second]) {
        const row = await VenueBooking.findByPk(original.id);
        expect(row).not.toBeNull();
        expect(row.status).toBe('approved');
        expect(row.startDatetime).toEqual(original.startDatetime);
        expect(row.endDatetime).toEqual(original.endDatetime);
        expect(row.conflictFlaggedAt).toBeInstanceOf(Date);
        expect(row.conflictDetails[0]).toMatchObject({ type: 'booking' });
      }
      expect((await VenueBooking.findByPk(untouched.id)).conflictFlaggedAt).toBeNull();
    });

    test("each affected event's coordinator is notified once", async () => {
      const forA = await Notification.findAll({
        where: { userId: coordA.id, venueBookingId: first.id, type: 'venue_booking_conflict_flagged' },
      });
      expect(forA).toHaveLength(1);
      expect(forA[0].message).toMatch(/kept and flagged/);
      expect(forA[0].message).toMatch(/setup\/turnaround/);

      // Re-auditing does not notify again.
      await runAudit({ venueIds: [hall.id] });
      expect(
        await Notification.count({ where: { userId: coordA.id, venueBookingId: first.id, type: 'venue_booking_conflict_flagged' } })
      ).toBe(1);
    });

    test('Venue Staff can list flagged bookings', async () => {
      const res = await request(app)
        .get('/api/venue-bookings')
        .query({ flagged: 'true', venueId: hall.id })
        .set(auth(tStaff));
      expect(res.status).toBe(200);
      expect(res.body.bookings.map((b) => b.id).sort()).toEqual([first.id, second.id].sort());
    });

    test('changing a venue field that does not affect the schedule skips the audit', async () => {
      const res = await patchVenue(hall, { location: 'Audit Wing West' });
      expect(res.status).toBe(200);
      expect(res.body.conflictAudit).toBeUndefined();
    });

    test('a flagged booking that is re-timed and passes the checks is unflagged', async () => {
      const res = await request(app)
        .patch(`/api/venue-bookings/${second.id}`)
        .set(auth(tCoordB))
        .send({ startDatetime: at('13:00'), endDatetime: at('15:00') });
      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ status: 'pending', conflictFlaggedAt: null });
    });

    test('once nothing conflicts any more, the audit clears the remaining flag', async () => {
      const res = await runAudit({ venueIds: [hall.id] });
      expect(res.status).toBe(200);
      expect(res.body.venues[0].cleared.map((c) => c.id)).toEqual([first.id]);
      expect((await VenueBooking.findByPk(first.id)).conflictFlaggedAt).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  describe('audit covers holds, unavailability and venue status', () => {
    test('an active hold that overlaps an existing booking flags it; once the hold expires the flag clears', async () => {
      const venue = await createVenue('Hold Overlap');
      const booking = await legacyBooking(eventA, venue, coordA, at('10:00'), at('12:00'));
      // Legacy data: a hold for another event that overlaps the booking.
      const hold = await VenueHold.create({
        venueId: venue.id,
        eventId: eventB.id,
        heldBy: coordB.id,
        startDatetime: at('11:00'),
        endDatetime: at('13:00'),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const flagged = await runAudit({ venueIds: [venue.id] });
      expect(flagged.body.venues[0].flagged).toEqual([
        expect.objectContaining({ id: booking.id, conflicts: [expect.objectContaining({ type: 'tentative_hold', id: hold.id })] }),
      ]);

      await hold.update({ expiresAt: new Date(Date.now() - 1000) });
      const cleared = await runAudit({ venueIds: [venue.id] });
      expect(cleared.body.venues[0].cleared.map((c) => c.id)).toEqual([booking.id]);
    });

    test('recording unavailability flags events booked directly on the venue; removing it clears them', async () => {
      const venue = await createVenue('Direct');
      const directEvent = await createEvent(organiser, coordA, 'Direct Venue Event', {
        venueId: venue.id,
        startDatetime: at('10:00'),
        endDatetime: at('12:00'),
        status: 'confirmed',
      });

      const created = await request(app)
        .post(`/api/venues/${venue.id}/unavailability`)
        .set(auth(tStaff))
        .send({ startDateTime: at('11:00'), endDateTime: at('11:30'), reason: 'Fire drill' });
      expect(created.status).toBe(201);
      expect(created.body.conflictAudit.venues[0].flagged).toEqual([
        expect.objectContaining({ type: 'event', id: directEvent.id }),
      ]);

      const row = await Event.findByPk(directEvent.id);
      expect(row.status).toBe('confirmed'); // preserved
      expect(row.venueId).toBe(venue.id);
      expect(row.venueConflictFlaggedAt).toBeInstanceOf(Date);
      expect(row.venueConflictDetails[0]).toMatchObject({ type: 'unavailability', reason: 'Fire drill' });

      const del = await request(app)
        .delete(`/api/venues/${venue.id}/unavailability/${created.body.unavailability.id}`)
        .set(auth(tStaff));
      expect(del.status).toBe(204);
      expect((await Event.findByPk(directEvent.id)).venueConflictFlaggedAt).toBeNull();
    });

    test('marking a venue as under maintenance flags its live bookings without cancelling them', async () => {
      const venue = await createVenue('Maintenance');
      const booking = await legacyBooking(eventA, venue, coordA, at('10:00'), at('11:00'), 'pending');
      const res = await patchVenue(venue, { status: 'maintenance' });
      expect(res.body.conflictAudit.venues[0].flagged[0]).toMatchObject({
        id: booking.id,
        conflicts: [expect.objectContaining({ type: 'venue_status' })],
      });
      expect((await VenueBooking.findByPk(booking.id)).status).toBe('pending');
    });

    test('each venue is audited independently', async () => {
      const busy = await createVenue('Indep Busy');
      const calm = await createVenue('Indep Calm');
      const a = await legacyBooking(eventA, busy, coordA, at('10:00'), at('12:00'));
      const b = await legacyBooking(eventB, busy, coordB, at('11:00'), at('13:00'));
      // Same times, same events, different venue: no conflict there.
      const c = await legacyBooking(eventB, calm, coordB, at('10:00'), at('12:00'));

      const res = await runAudit({ venueIds: [busy.id, calm.id] });
      const [busyResult, calmResult] = res.body.venues;
      expect(busyResult.flagged.map((f) => f.id).sort()).toEqual([a.id, b.id].sort());
      expect(calmResult.flagged).toEqual([]);
      expect((await VenueBooking.findByPk(c.id)).conflictFlaggedAt).toBeNull();
    });

    test('with no venueIds the audit covers every venue with live reservations', async () => {
      const res = await runAudit();
      expect(res.status).toBe(200);
      expect(res.body.totals.checked).toBeGreaterThan(0);
    });
  });

  describe('access control and validation', () => {
    test('only Venue Staff may run the audit', async () => {
      expect((await runAudit({}, tCoordA)).status).toBe(403);
      expect((await request(app).post('/api/venues/conflicts/audit').send({})).status).toBe(401);
    });

    test('400 for bad venue ids, 404 for unknown venues', async () => {
      expect((await runAudit({ venueIds: ['nope'] })).status).toBe(400);
      expect((await runAudit({ venueIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(404);
    });
  });
});
