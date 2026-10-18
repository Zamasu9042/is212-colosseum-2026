// tests/venueBooking.test.js
//
// Integration tests for:
//   - Submit Venue Booking Request
//   - Book Multiple Venues for One Event
//   - Mark Venue Temporarily Unavailable
//
// Run `npm run db:reset && npm run db:seed` first (new tables come from
// src/migrations/schema.sql). Everything created here uses a unique
// per-run suffix so the suite is safe to re-run.

const request = require('supertest');
const app = require('../src/app');
const {
  sequelize, Role, User, Venue, Event, EventRequest, VenueBooking, ROLE_NAMES,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function createUser(roleName, label) {
  const [role] = await Role.findOrCreate({
    where: { name: roleName },
    defaults: { name: roleName, displayName: roleName },
  });
  return User.create({
    email: `vb-${label}-${suffix}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Test',
    lastName: label,
    roleId: role.id,
  });
}

async function login(user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  return res.body.accessToken;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function makeVenue(label, overrides = {}) {
  return Venue.create({
    name: `VB ${label} ${suffix}`,
    location: 'Test Location',
    capacity: 200,
    venueType: 'Hall',
    status: 'available',
    setupMinutes: 30,
    teardownMinutes: 30,
    ...overrides,
  });
}

async function makeEvent(organiser, coordinator, attendance = 100) {
  const eventRequest = await EventRequest.create({
    organiserId: organiser.id,
    eventName: `VB Event ${suffix}`,
    preferredStart: new Date('2027-03-01T09:00:00Z'),
    preferredEnd: new Date('2027-03-01T17:00:00Z'),
    expectedAttendance: attendance,
    status: 'approved',
  });
  return Event.create({
    eventRequestId: eventRequest.id,
    coordinatorId: coordinator.id,
    startDatetime: new Date('2027-03-01T09:00:00Z'),
    endDatetime: new Date('2027-03-01T17:00:00Z'),
    status: 'planning',
  });
}

const slot = (startH, endH, day = '2027-03-01') => ({
  startDatetime: `${day}T${String(startH).padStart(2, '0')}:00:00Z`,
  endDatetime: `${day}T${String(endH).padStart(2, '0')}:00:00Z`,
});

describe('Venue bookings', () => {
  let organiser, otherOrganiser, coordinator, otherCoordinator, staff;
  let tOrganiser, tOtherOrganiser, tCoordinator, tOtherCoordinator, tStaff;
  let event, otherEvent;
  let hall, annex, tiny;

  beforeAll(async () => {
    organiser = await createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    otherOrganiser = await createUser(ROLE_NAMES.EVENT_ORGANISER, 'org2');
    coordinator = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    staff = await createUser(ROLE_NAMES.VENUE_STAFF, 'staff');
    [tOrganiser, tOtherOrganiser, tCoordinator, tOtherCoordinator, tStaff] = await Promise.all([
      login(organiser), login(otherOrganiser), login(coordinator), login(otherCoordinator), login(staff),
    ]);

    event = await makeEvent(organiser, coordinator, 100);
    otherEvent = await makeEvent(otherOrganiser, otherCoordinator, 50);
    hall = await makeVenue('Hall');
    annex = await makeVenue('Annex');
    tiny = await makeVenue('Tiny', { capacity: 10 });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  const book = (token, ev, venue, body = {}) =>
    request(app)
      .post(`/api/events/${ev.id}/venue-bookings`)
      .set(auth(token))
      .send({ venueId: venue.id, ...slot(9, 12), requirements: 'Projector', ...body });

  // ---------------------------------------------------------------
  describe('Submit Venue Booking Request', () => {
    it('lets the assigned coordinator submit a booking that venue staff can see', async () => {
      const res = await book(tCoordinator, event, hall);
      expect(res.status).toBe(201);
      expect(res.body.booking.status).toBe('pending');
      expect(res.body.booking.eventId).toBe(event.id);
      expect(res.body.booking.venueId).toBe(hall.id);
      expect(res.body.booking.requirements).toBe('Projector');

      const queue = await request(app).get('/api/venue-bookings').set(auth(tStaff));
      expect(queue.status).toBe(200);
      expect(queue.body.bookings.map((b) => b.id)).toContain(res.body.booking.id);
    });

    it('rejects incomplete requests', async () => {
      for (const missing of ['venueId', 'startDatetime', 'endDatetime']) {
        const body = { venueId: annex.id, ...slot(13, 15) };
        delete body[missing];
        const res = await request(app)
          .post(`/api/events/${event.id}/venue-bookings`)
          .set(auth(tCoordinator))
          .send(body);
        expect(res.status).toBe(400);
      }
    });

    it('rejects an end time that is not after the start', async () => {
      const res = await book(tCoordinator, event, annex, slot(15, 13));
      expect(res.status).toBe(400);
    });

    it('only the coordinator assigned to the event may submit', async () => {
      expect((await book(tOtherCoordinator, event, annex)).status).toBe(403);
      expect((await book(tOrganiser, event, annex)).status).toBe(403);
      expect((await book(tStaff, event, annex)).status).toBe(403);
    });

    it('returns 404 for an unknown venue', async () => {
      const res = await request(app)
        .post(`/api/events/${event.id}/venue-bookings`)
        .set(auth(tCoordinator))
        .send({ venueId: '00000000-0000-4000-8000-000000000000', ...slot(13, 15) });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------
  describe('Book Multiple Venues for One Event', () => {
    it('AC1/AC2/AC7: allows several venues, all linked to the same event and viewable', async () => {
      const second = await book(tCoordinator, event, annex, slot(13, 15));
      expect(second.status).toBe(201);
      expect(second.body.booking.eventId).toBe(event.id);

      for (const token of [tCoordinator, tOrganiser, tStaff]) {
        const list = await request(app).get(`/api/events/${event.id}/venue-bookings`).set(auth(token));
        expect(list.status).toBe(200);
        expect(list.body.count).toBeGreaterThanOrEqual(2);
        expect(list.body.bookings.every((b) => b.eventId === event.id)).toBe(true);
        const venueIds = list.body.bookings.map((b) => b.venueId);
        expect(venueIds).toEqual(expect.arrayContaining([hall.id, annex.id]));
      }
    });

    it('AC7: users without access cannot view the bookings', async () => {
      expect((await request(app).get(`/api/events/${event.id}/venue-bookings`).set(auth(tOtherOrganiser))).status).toBe(403);
      expect((await request(app).get(`/api/events/${event.id}/venue-bookings`).set(auth(tOtherCoordinator))).status).toBe(403);
    });

    it('AC3: suitability is checked per venue without affecting other bookings', async () => {
      const before = await VenueBooking.count({ where: { eventId: event.id } });
      const res = await book(tCoordinator, event, tiny, slot(9, 12));
      expect(res.status).toBe(422);
      expect(res.body.failures.map((f) => f.check)).toContain('suitability');
      expect(await VenueBooking.count({ where: { eventId: event.id } })).toBe(before);
    });

    it('AC4: an unavailable (maintenance) venue is refused', async () => {
      const closed = await makeVenue('Closed', { status: 'maintenance' });
      const res = await book(tCoordinator, event, closed, slot(9, 12));
      expect(res.status).toBe(422);
      expect(res.body.failures.map((f) => f.check)).toContain('availability');
    });

    it('AC5: conflicts with other bookings (including setup/teardown) are refused', async () => {
      const shared = await makeVenue('Shared');
      expect((await book(tOtherCoordinator, otherEvent, shared, slot(9, 12))).status).toBe(201);

      // overlaps directly
      let res = await book(tCoordinator, event, shared, slot(11, 13));
      expect(res.status).toBe(422);
      expect(res.body.failures.map((f) => f.check)).toContain('conflict');

      // starts inside the 30-minute teardown window after 12:00
      res = await request(app)
        .post(`/api/events/${event.id}/venue-bookings`)
        .set(auth(tCoordinator))
        .send({ venueId: shared.id, startDatetime: '2027-03-01T12:10:00Z', endDatetime: '2027-03-01T14:00:00Z' });
      expect(res.status).toBe(422);

      // clear of the buffer
      expect((await book(tCoordinator, event, shared, slot(13, 15))).status).toBe(201);
    });

    it('AC5: the same event cannot double-book the same venue for overlapping times', async () => {
      const dup = await book(tCoordinator, event, hall, slot(10, 11));
      expect(dup.status).toBe(422);
      expect(dup.body.failures.map((f) => f.check)).toContain('conflict');
    });

    it('AC6: changing or cancelling one booking leaves the others untouched', async () => {
      const venueA = await makeVenue('AC6-A');
      const venueB = await makeVenue('AC6-B');
      const ev = await makeEvent(organiser, coordinator, 40);
      const a = (await book(tCoordinator, ev, venueA, slot(9, 11))).body.booking;
      const b = (await book(tCoordinator, ev, venueB, slot(9, 11))).body.booking;

      const patched = await request(app)
        .patch(`/api/venue-bookings/${a.id}`)
        .set(auth(tCoordinator))
        .send({ ...slot(10, 12), requirements: 'Updated' });
      expect(patched.status).toBe(200);
      expect(patched.body.booking.requirements).toBe('Updated');

      const cancelled = await request(app).post(`/api/venue-bookings/${a.id}/cancel`).set(auth(tCoordinator));
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.booking.status).toBe('cancelled');

      const untouched = await VenueBooking.findByPk(b.id);
      expect(untouched.status).toBe('pending');
      expect(untouched.venueId).toBe(venueB.id);
      expect(untouched.requirements).toBe('Projector');
      expect(new Date(untouched.startDatetime).toISOString()).toBe('2027-03-01T09:00:00.000Z');

      // already cancelled -> cannot cancel again
      expect((await request(app).post(`/api/venue-bookings/${a.id}/cancel`).set(auth(tCoordinator))).status).toBe(409);
    });

    it('AC8 (default): bookings are approved/rejected independently by venue staff', async () => {
      const venueA = await makeVenue('AC8-A');
      const venueB = await makeVenue('AC8-B');
      const ev = await makeEvent(organiser, coordinator, 40);
      const a = (await book(tCoordinator, ev, venueA)).body.booking;
      const b = (await book(tCoordinator, ev, venueB)).body.booking;

      expect((await request(app).post(`/api/venue-bookings/${b.id}/reject`).set(auth(tStaff)).send({})).status).toBe(400);

      const approved = await request(app).post(`/api/venue-bookings/${a.id}/approve`).set(auth(tStaff));
      expect(approved.status).toBe(200);
      expect(approved.body.booking.status).toBe('approved');

      const rejected = await request(app)
        .post(`/api/venue-bookings/${b.id}/reject`)
        .set(auth(tStaff))
        .send({ reason: 'Double-booked internally' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.booking.status).toBe('rejected');

      expect((await VenueBooking.findByPk(a.id)).status).toBe('approved');
      // coordinators cannot review
      expect((await request(app).post(`/api/venue-bookings/${a.id}/approve`).set(auth(tCoordinator))).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------
  describe('Mark Venue Temporarily Unavailable', () => {
    let venue, spare, ev, booking;
    const period = {
      startDateTime: '2027-04-01T00:00:00Z',
      endDateTime: '2027-04-05T00:00:00Z',
      reasonCategory: 'maintenance',
      reason: 'Air-conditioning replacement',
    };

    beforeAll(async () => {
      venue = await makeVenue('Unavail');
      spare = await makeVenue('Spare');
      ev = await makeEvent(organiser, coordinator, 80);
      const res = await book(tCoordinator, ev, venue, slot(9, 12, '2027-04-02'));
      booking = res.body.booking;
      await request(app).post(`/api/venue-bookings/${booking.id}/approve`).set(auth(tStaff));
    });

    it('validates input and restricts to venue staff', async () => {
      const url = `/api/venues/${venue.id}/unavailability`;
      expect((await request(app).post(url).set(auth(tCoordinator)).send(period)).status).toBe(403);
      expect((await request(app).post(url).set(auth(tStaff)).send({ ...period, reasonCategory: 'fun' })).status).toBe(400);
      expect((await request(app).post(url).set(auth(tStaff)).send({ ...period, reason: undefined })).status).toBe(400);
      expect((await request(app).post(url).set(auth(tStaff)).send({ ...period, endDateTime: period.startDateTime })).status).toBe(400);
    });

    it('AC1-2, AC4-7: records the period, flags overlapping bookings, keeps the event, notifies the coordinator', async () => {
      const res = await request(app)
        .post(`/api/venues/${venue.id}/unavailability`)
        .set(auth(tStaff))
        .send(period);
      expect(res.status).toBe(201);
      expect(res.body.unavailability.reasonCategory).toBe('maintenance');
      expect(res.body.unavailability.reason).toBe('Air-conditioning replacement');
      expect(res.body.affectedBookings.map((b) => b.bookingId)).toContain(booking.id);
      expect(res.body.notificationsSent).toBeGreaterThanOrEqual(1);

      // AC5/AC6: event not cancelled, booking details preserved
      const eventAfter = await Event.findByPk(ev.id);
      expect(eventAfter.status).toBe('planning');
      const bookingAfter = await VenueBooking.findByPk(booking.id);
      expect(bookingAfter.status).toBe('needs_replacement');
      expect(bookingAfter.venueId).toBe(venue.id);
      expect(new Date(bookingAfter.startDatetime).toISOString()).toBe('2027-04-02T09:00:00.000Z');
      expect(bookingAfter.requirements).toBe('Projector');

      // AC7: coordinator is notified; nobody else is
      const mine = await request(app).get('/api/notifications').set(auth(tCoordinator));
      const note = mine.body.notifications.find((n) => n.venueBookingId === booking.id);
      expect(note).toBeTruthy();
      expect(note.type).toBe('venue_unavailable');
      expect(note.message).toMatch(/alternative venue/i);
      const others = await request(app).get('/api/notifications').set(auth(tOtherCoordinator));
      expect(others.body.notifications.find((n) => n.venueBookingId === booking.id)).toBeUndefined();

      const read = await request(app).patch(`/api/notifications/${note.id}/read`).set(auth(tCoordinator));
      expect(read.status).toBe(200);
      expect(read.body.notification.readAt).toBeTruthy();
    });

    it('AC3: new bookings cannot overlap the period, and search shows the venue as unavailable', async () => {
      const ev2 = await makeEvent(organiser, coordinator, 30);
      const res = await book(tCoordinator, ev2, venue, slot(9, 12, '2027-04-03'));
      expect(res.status).toBe(422);
      expect(res.body.failures.map((f) => f.check)).toContain('availability');

      const search = await request(app)
        .get('/api/venues')
        .query({ name: venue.name, startDateTime: '2027-04-03T09:00:00Z', endDateTime: '2027-04-03T12:00:00Z' })
        .set(auth(tCoordinator));
      expect(search.body.venues[0].isAvailable).toBe(false);

      // outside the period is still bookable
      expect((await book(tCoordinator, ev2, venue, slot(9, 12, '2027-04-10'))).status).toBe(201);
    });

    it('AC8: the coordinator can search for and request a replacement venue', async () => {
      const search = await request(app)
        .get(`/api/venue-bookings/${booking.id}/replacement-venues`)
        .set(auth(tCoordinator));
      expect(search.status).toBe(200);
      const ids = search.body.venues.map((v) => v.id);
      expect(ids).toContain(spare.id);
      expect(ids).not.toContain(venue.id);

      // other coordinators can't use it
      expect(
        (await request(app).get(`/api/venue-bookings/${booking.id}/replacement-venues`).set(auth(tOtherCoordinator))).status
      ).toBe(403);

      const replaced = await request(app)
        .post(`/api/venue-bookings/${booking.id}/replace`)
        .set(auth(tCoordinator))
        .send({ venueId: spare.id });
      expect(replaced.status).toBe(201);
      expect(replaced.body.booking.venueId).toBe(spare.id);
      expect(replaced.body.booking.status).toBe('pending');
      expect(replaced.body.booking.replacesBookingId).toBe(booking.id);
      expect(replaced.body.booking.eventId).toBe(ev.id);
      expect((await VenueBooking.findByPk(booking.id)).status).toBe('replaced');

      // a booking that doesn't need replacing can't be replaced
      expect(
        (await request(app).post(`/api/venue-bookings/${booking.id}/replace`).set(auth(tCoordinator)).send({ venueId: spare.id })).status
      ).toBe(409);
    });
  });
});