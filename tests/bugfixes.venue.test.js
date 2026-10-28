// Regression tests for venue bugs found in the October code review.
//  BUG-1  Concurrent venue booking requests/approvals could double-book a
//         venue: the conflict check and the insert were not serialised.
//  BUG-2  The venue availability calendar ignored venue booking requests,
//         active tentative holds and unavailability periods, so it showed
//         slots as available that a booking request would be refused for.
const {
  sequelize, ROLE_NAMES, VenueBooking, VenueHold, VenueUnavailability, EventRequest, Event,
} = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('bugv');

describe('Venue bug fixes', () => {
  let organiser, coordA, coordB, staff, tokenA, tokenB, staffToken;

  beforeAll(async () => {
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    coordA = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'ca');
    coordB = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'cb');
    staff = await fx.createUser(ROLE_NAMES.VENUE_STAFF, 'staff');
    [tokenA, tokenB, staffToken] = await Promise.all([coordA, coordB, staff].map(fx.login));
  });
  afterAll(async () => { await sequelize.close(); });

  describe('BUG-1 concurrent venue bookings cannot double-book', () => {
    test('two coordinators requesting the same slot at once: exactly one succeeds', async () => {
      const venue = await fx.makeVenue('Race Hall', { setupMinutes: 0, teardownMinutes: 0 });
      const evA = await fx.makeEvent({ organiser, coordinator: coordA, start: '2028-01-10T09:00:00Z', end: '2028-01-10T12:00:00Z' });
      const evB = await fx.makeEvent({ organiser, coordinator: coordB, start: '2028-01-10T09:00:00Z', end: '2028-01-10T12:00:00Z' });
      const body = { venueId: venue.id, startDatetime: '2028-01-10T09:00:00Z', endDatetime: '2028-01-10T12:00:00Z', expectedAttendance: 50 };
      const results = await Promise.all([
        request(app).post(`/api/events/${evA.id}/venue-bookings`).set(auth(tokenA)).send(body),
        request(app).post(`/api/events/${evB.id}/venue-bookings`).set(auth(tokenB)).send(body),
        request(app).post(`/api/events/${evA.id}/venue-bookings`).set(auth(tokenA)).send(body),
      ]);
      const created = results.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      results.filter((r) => r.status !== 201).forEach((r) => expect(r.status).toBe(422));
      expect(await VenueBooking.count({ where: { venueId: venue.id } })).toBe(1);
    });
  });

  describe('BUG-2 calendar reflects bookings, holds and unavailability', () => {
    let venue;
    const slotsFor = async (token) => {
      const res = await request(app).get(`/api/venues/availability?date=2028-02-01&venueId=${venue.id}`).set(auth(token));
      expect(res.status).toBe(200);
      return res.body.availability[0].slots;
    };
    const stateAt = (slots, iso) => slots.find((s) => new Date(s.startDateTime) <= new Date(iso) && new Date(iso) < new Date(s.endDateTime))?.state;

    beforeAll(async () => {
      venue = await fx.makeVenue('Calendar Hall', { setupMinutes: 0, teardownMinutes: 0 });
      const ev = await fx.makeEvent({ organiser, coordinator: coordA, start: '2028-02-01T01:00:00Z', end: '2028-02-01T20:00:00Z' });
      await VenueBooking.create({ eventId: ev.id, venueId: venue.id, requestedBy: coordA.id, startDatetime: '2028-02-01T01:00:00Z', endDatetime: '2028-02-01T03:00:00Z', expectedAttendance: 10, status: 'pending' });
      await VenueBooking.create({ eventId: ev.id, venueId: venue.id, requestedBy: coordA.id, startDatetime: '2028-02-01T04:00:00Z', endDatetime: '2028-02-01T06:00:00Z', expectedAttendance: 10, status: 'approved' });
      await VenueBooking.create({ eventId: ev.id, venueId: venue.id, requestedBy: coordA.id, startDatetime: '2028-02-01T07:00:00Z', endDatetime: '2028-02-01T08:00:00Z', expectedAttendance: 10, status: 'rejected' });
      await VenueHold.create({ venueId: venue.id, heldBy: coordA.id, startDatetime: '2028-02-01T10:00:00Z', endDatetime: '2028-02-01T11:00:00Z', expiresAt: '2028-01-31T00:00:00Z', status: 'active' });
      await VenueUnavailability.create({ venueId: venue.id, startDatetime: '2028-02-01T13:00:00Z', endDatetime: '2028-02-01T15:00:00Z', reason: 'Aircon repair', createdBy: staff.id });
    });

    test('pending booking shows as a tentative hold', async () => {
      expect(stateAt(await slotsFor(staffToken), '2028-02-01T02:00:00Z')).toBe('tentative_hold');
    });
    test('approved booking shows as a confirmed booking', async () => {
      expect(stateAt(await slotsFor(staffToken), '2028-02-01T05:00:00Z')).toBe('confirmed_booking');
    });
    test('rejected booking leaves the slot available', async () => {
      expect(stateAt(await slotsFor(staffToken), '2028-02-01T07:30:00Z')).toBe('available');
    });
    test('active tentative hold shows as a tentative hold', async () => {
      expect(stateAt(await slotsFor(staffToken), '2028-02-01T10:30:00Z')).toBe('tentative_hold');
    });
    test('unavailability period shows as temporarily unavailable', async () => {
      expect(stateAt(await slotsFor(staffToken), '2028-02-01T14:00:00Z')).toBe('temporarily_unavailable');
    });
    test('calendar agrees with the booking check: a pending slot is refused', async () => {
      const ev = await fx.makeEvent({ organiser, coordinator: coordB, start: '2028-02-01T01:30:00Z', end: '2028-02-01T02:30:00Z' });
      const res = await request(app).post(`/api/events/${ev.id}/venue-bookings`).set(auth(tokenB))
        .send({ venueId: venue.id, startDatetime: '2028-02-01T01:30:00Z', endDatetime: '2028-02-01T02:30:00Z', expectedAttendance: 10 });
      expect(res.status).toBe(422);
    });
  });
});
