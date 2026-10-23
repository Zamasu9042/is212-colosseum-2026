// tests/venueHoldExpiry.test.js
//
// Integration tests for "Manage Expiring Tentative Venue Holds" (Week 7)
// against the real app + test Postgres DB (`npm run db:init && npm run db:seed`).
// Every run uses uniquely named users/venues, so the suite is re-runnable.
//
// Time travel: holds are placed through the API, then their expires_at is
// moved into the past/near future directly in the DB, and the real sweep
// (POST /api/venues/holds/process-expiries) is run.

const request = require('supertest');
const app = require('../src/app');
const {
  sequelize, Role, User, Venue, Event, EventRequest, VenueHold, VenueBooking, Notification, ROLE_NAMES,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');
const { processHoldExpiries } = require('../src/services/holdExpiryService');

const PASSWORD = 'Passw0rd1';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const DAY = '2027-05-20';
const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;
const HOUR = 60 * 60 * 1000;

async function createUser(roleName, label) {
  const [role] = await Role.findOrCreate({ where: { name: roleName }, defaults: { name: roleName, displayName: roleName } });
  return User.create({
    email: `hold-${label}-${RUN}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Hold',
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
    name: `Hold Test ${label} ${RUN}`,
    location: 'Expiry Wing',
    capacity: 200,
    setupMinutes: 30,
    teardownMinutes: 30,
    status: 'available',
    ...overrides,
  });
}

async function createEvent(organiser, coordinator, name) {
  const er = await EventRequest.create({
    organiserId: organiser.id,
    eventName: `${name} ${RUN}`,
    expectedAttendance: 50,
    status: 'approved',
  });
  return Event.create({
    eventRequestId: er.id,
    coordinatorId: coordinator.id,
    startDatetime: at('09:00'),
    endDatetime: at('17:00'),
    status: 'planning',
  });
}

const moveExpiry = (holdId, date) => VenueHold.update({ expiresAt: date }, { where: { id: holdId } });

describe('Manage Expiring Tentative Venue Holds', () => {
  let staff, coordinator, otherCoordinator, organiser;
  let tStaff, tCoord, tOther, tOrganiser;
  let room, eventA, eventB;

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const placeHold = (token, venue, body) =>
    request(app).post(`/api/venues/${venue.id}/holds`).set(auth(token)).send(body);
  const sweep = (token = tStaff) => request(app).post('/api/venues/holds/process-expiries').set(auth(token));
  const bookVenue = (token, event, venue, start, end) =>
    request(app)
      .post(`/api/events/${event.id}/venue-bookings`)
      .set(auth(token))
      .send({ venueId: venue.id, startDatetime: start, endDatetime: end });
  const notificationsFor = (user, holdId, type) =>
    Notification.findAll({ where: { userId: user.id, venueHoldId: holdId, type } });

  beforeAll(async () => {
    staff = await createUser(ROLE_NAMES.VENUE_STAFF, 'staff');
    coordinator = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    organiser = await createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    [tStaff, tCoord, tOther, tOrganiser] = await Promise.all([
      login(staff), login(coordinator), login(otherCoordinator), login(organiser),
    ]);
    room = await createVenue('Room');
    eventA = await createEvent(organiser, coordinator, 'Hold Event A');
    eventB = await createEvent(organiser, otherCoordinator, 'Hold Event B');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // -----------------------------------------------------------------
  describe('AC1 — Expiry required', () => {
    test('a hold placed without an expiry gets the default 72h deadline', async () => {
      const before = Date.now();
      const res = await placeHold(tCoord, room, { startDateTime: at('07:00'), endDateTime: at('07:30') });
      expect(res.status).toBe(201);
      const expiresAt = new Date(res.body.hold.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 72 * HOUR - 5000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 72 * HOUR + 5000);
      expect(res.body.hold).toMatchObject({ status: 'active', isActive: true, effectiveStatus: 'active' });
      await VenueHold.destroy({ where: { id: res.body.hold.id } });
    });

    test('an explicit expiry later than the slot start is refused', async () => {
      const res = await placeHold(tCoord, room, {
        startDateTime: at('07:00'),
        endDateTime: at('07:30'),
        expiresAt: '2027-05-21T00:00:00Z',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be later than the start/);
    });

    test('a hold on a slot that has already started is refused', async () => {
      const res = await placeHold(tCoord, room, {
        startDateTime: '2020-01-01T09:00:00Z',
        endDateTime: '2020-01-01T10:00:00Z',
      });
      expect(res.status).toBe(400);
    });

    test('the database refuses a hold without an expiry', async () => {
      await expect(
        VenueHold.create({ venueId: room.id, startDatetime: at('06:00'), endDatetime: at('06:30') })
      ).rejects.toThrow(/expiry/);
    });
  });

  // -----------------------------------------------------------------
  describe('AC2–AC6 — lifecycle of one hold', () => {
    let hold;

    test('AC2 — while active, the slot is not available to conflicting requests', async () => {
      const res = await placeHold(tCoord, room, {
        startDateTime: at('10:00'),
        endDateTime: at('12:00'),
        eventId: eventA.id,
        expiresAt: new Date(Date.now() + 48 * HOUR).toISOString(),
      });
      expect(res.status).toBe(201);
      hold = res.body.hold;

      // Another coordinator's booking request is refused with the hold as the reason.
      const booking = await bookVenue(tOther, eventB, room, at('11:00'), at('13:00'));
      expect(booking.status).toBe(422);
      const conflict = booking.body.failures.find((f) => f.check === 'conflict');
      expect(conflict.details).toEqual([expect.objectContaining({ type: 'tentative_hold', id: hold.id })]);

      // ...and so is another hold.
      expect((await placeHold(tOther, room, { startDateTime: at('11:00'), endDateTime: at('11:30') })).status).toBe(409);

      // Venue search also reports it unavailable.
      const search = await request(app)
        .get(`/api/venues/${room.id}`)
        .set(auth(tOther))
        .query({ startDateTime: at('11:00'), endDateTime: at('13:00') });
      expect(search.body.venue.isAvailable).toBe(false);
    });

    test('AC7 setup — the holder can still submit its own booking request for the held slot', async () => {
      const res = await bookVenue(tCoord, eventA, room, at('10:00'), at('12:00'));
      expect(res.status).toBe(201);
      expect(res.body.booking.status).toBe('pending');
      // Withdraw it again so the rest of the lifecycle tests the hold alone.
      await VenueBooking.update({ status: 'cancelled' }, { where: { id: res.body.booking.id } });
    });

    test('AC6 — the coordinator is reminded once when the deadline is near', async () => {
      await moveExpiry(hold.id, new Date(Date.now() + 2 * HOUR));

      const first = await sweep();
      expect(first.status).toBe(200);
      expect(first.body.warned.map((w) => w.holdId)).toContain(hold.id);

      const notes = await notificationsFor(coordinator, hold.id, 'venue_hold_expiring');
      expect(notes).toHaveLength(1);
      expect(notes[0].eventId).toBe(eventA.id);
      expect(notes[0].message).toMatch(/expires at/);
      expect(notes[0].message).toMatch(room.name);

      const second = await sweep();
      expect(second.body.warned.map((w) => w.holdId)).not.toContain(hold.id);
      expect(await notificationsFor(coordinator, hold.id, 'venue_hold_expiring')).toHaveLength(1);

      // Still active — a reminder does not expire anything.
      expect((await VenueHold.findByPk(hold.id)).status).toBe('active');
    });

    test('AC4 — the slot is released the moment the deadline passes, before any sweep', async () => {
      await moveExpiry(hold.id, new Date(Date.now() - 60 * 1000));

      const check = await request(app)
        .post('/api/venues/conflicts')
        .set(auth(tOther))
        .send({ venueIds: [room.id], startDateTime: at('11:00'), endDateTime: at('13:00') });
      expect(check.body.hasConflicts).toBe(false);

      const list = await request(app).get(`/api/venues/${room.id}/holds`).set(auth(tStaff));
      const listed = list.body.holds.find((h) => h.id === hold.id);
      expect(listed).toMatchObject({ status: 'active', isActive: false, effectiveStatus: 'expired' });
    });

    test('an elapsed hold cannot be released as if it were still live', async () => {
      const res = await request(app)
        .patch(`/api/venues/${room.id}/holds/${hold.id}/release`)
        .set(auth(tCoord));
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/expired/);
    });

    test('AC3 + AC6 — the sweep expires the hold and tells the coordinator', async () => {
      const res = await sweep();
      expect(res.body.expired.map((e) => e.holdId)).toContain(hold.id);

      const row = await VenueHold.findByPk(hold.id);
      expect(row.status).toBe('expired');
      expect(row.expiredAt).toBeInstanceOf(Date);

      const notes = await notificationsFor(coordinator, hold.id, 'venue_hold_expired');
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toMatch(/released/);
      expect(notes[0].message).toMatch(/NOT booked/);

      // Shows up in the coordinator's own notification feed.
      const feed = await request(app).get('/api/notifications').set(auth(tCoord));
      expect(feed.body.notifications.map((n) => n.type)).toEqual(
        expect.arrayContaining(['venue_hold_expiring', 'venue_hold_expired'])
      );

      // Running again does nothing more.
      const again = await sweep();
      expect(again.body.expired.map((e) => e.holdId)).not.toContain(hold.id);
      expect(await notificationsFor(coordinator, hold.id, 'venue_hold_expired')).toHaveLength(1);
    });

    test('AC4 — after expiry the slot can be booked by someone else', async () => {
      const res = await bookVenue(tOther, eventB, room, at('11:00'), at('13:00'));
      expect(res.status).toBe(201);
    });

    test('AC5 — an expired hold is not a confirmed booking', async () => {
      const row = await VenueHold.findByPk(hold.id);
      expect(row.status).toBe('expired');
      expect(row.status).not.toBe('converted');

      // No live venue booking exists for event A on the strength of the hold.
      const live = await VenueBooking.count({
        where: { eventId: eventA.id, venueId: room.id, status: ['pending', 'approved'] },
      });
      expect(live).toBe(0);

      // It cannot be released/acted on any more either.
      const release = await request(app)
        .patch(`/api/venues/${room.id}/holds/${hold.id}/release`)
        .set(auth(tStaff));
      expect(release.status).toBe(409);
      expect(release.body.error).toMatch(/already expired/);
    });
  });

  // -----------------------------------------------------------------
  describe('AC7 — booking request after expiry (TBD, current behaviour)', () => {
    test('expiry leaves an associated booking request untouched until the customer decides', async () => {
      const venue = await createVenue('AC7');
      const placed = await placeHold(tCoord, venue, {
        startDateTime: at('10:00'),
        endDateTime: at('12:00'),
        eventId: eventA.id,
      });
      const booking = await bookVenue(tCoord, eventA, venue, at('10:00'), at('12:00'));
      expect(booking.status).toBe(201);

      await moveExpiry(placed.body.hold.id, new Date(Date.now() - 1000));
      await sweep();

      expect((await VenueHold.findByPk(placed.body.hold.id)).status).toBe('expired');
      expect((await VenueBooking.findByPk(booking.body.booking.id)).status).toBe('pending');
    });
  });

  // -----------------------------------------------------------------
  describe('expiring-holds list and sweep endpoint', () => {
    let mine, theirs;

    beforeAll(async () => {
      const venue = await createVenue('List');
      mine = (await placeHold(tCoord, venue, {
        startDateTime: at('14:00'),
        endDateTime: at('15:00'),
        expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(),
      })).body.hold;
      theirs = (await placeHold(tOther, venue, {
        startDateTime: at('16:00'),
        endDateTime: at('17:00'),
        expiresAt: new Date(Date.now() + 30 * HOUR).toISOString(),
      })).body.hold;
    });

    test('a coordinator sees only their own holds that expire within the window', async () => {
      const res = await request(app).get('/api/venues/holds/expiring').set(auth(tCoord));
      expect(res.status).toBe(200);
      expect(res.body.withinHours).toBe(24);
      const ids = res.body.holds.map((h) => h.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(res.body.holds.find((h) => h.id === mine.id).Venue.name).toMatch(/List/);
    });

    test('the window is adjustable, and Venue Staff see everyone\'s holds', async () => {
      const coord = await request(app).get('/api/venues/holds/expiring?withinHours=48').set(auth(tOther));
      expect(coord.body.holds.map((h) => h.id)).toContain(theirs.id);
      expect(coord.body.holds.map((h) => h.id)).not.toContain(mine.id);

      const staffView = await request(app).get('/api/venues/holds/expiring?withinHours=48').set(auth(tStaff));
      expect(staffView.body.holds.map((h) => h.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    });

    test('validation and access control', async () => {
      expect((await request(app).get('/api/venues/holds/expiring?withinHours=-1').set(auth(tCoord))).status).toBe(400);
      expect((await request(app).get('/api/venues/holds/expiring').set(auth(tOrganiser))).status).toBe(403);
      expect((await sweep(tCoord)).status).toBe(403);
      expect((await request(app).post('/api/venues/holds/process-expiries')).status).toBe(401);
    });

    test('concurrent sweeps never double-expire or double-notify', async () => {
      await moveExpiry(theirs.id, new Date(Date.now() - 1000));
      await Promise.all([processHoldExpiries(), processHoldExpiries(), processHoldExpiries()]);
      expect((await VenueHold.findByPk(theirs.id)).status).toBe('expired');
      expect(await notificationsFor(otherCoordinator, theirs.id, 'venue_hold_expired')).toHaveLength(1);
    });
  });
});
