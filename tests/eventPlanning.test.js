// Manage Event Information During Planning — integration tests.
const { sequelize, ROLE_NAMES, Event, EventRequest, EventRegistration, VenueBooking, Notification } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('plan');

describe('Manage Event Information During Planning', () => {
  let coordinator, otherCoordinator, lead, organiser, otherOrganiser, tech, venueStaff;
  let tCoord, tOther, tLead, tOrg, tOtherOrg, tTech, tVenue;

  const patch = (ev, body, token = tCoord) =>
    request(app).patch(`/api/events/${ev.id}`).set(auth(token)).send(body);
  const fresh = (start = '2027-10-01T09:00:00Z', end = '2027-10-01T17:00:00Z', extra = {}) =>
    fx.makeEvent({ organiser, coordinator, start, end, ...extra });

  beforeAll(async () => {
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    lead = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    otherOrganiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org2');
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    venueStaff = await fx.createUser(ROLE_NAMES.VENUE_STAFF, 'venue');
    [tCoord, tOther, tLead, tOrg, tOtherOrg, tTech, tVenue] = await Promise.all(
      [coordinator, otherCoordinator, lead, organiser, otherOrganiser, tech, venueStaff].map(fx.login)
    );
  }, 30000);

  afterAll(async () => {
    await sequelize.close();
  });

  describe('editing event information', () => {
    test('an ordinary change updates the record, is logged, and does not flag reassessment', async () => {
      const ev = await fresh();
      const res = await patch(ev, {
        eventName: 'Renamed Summit',
        description: 'Updated event description',
        reason: 'Branding',
      });
      expect(res.status).toBe(200);
      expect(res.body.changeType).toBe('ordinary');
      expect(res.body.changes.eventName.to).toBe('Renamed Summit');
      expect(res.body.changes.description.to).toBe('Updated event description');
      expect(res.body.reassessment).toBeNull();
      const request_ = await EventRequest.findByPk(ev.eventRequestId);
      expect(request_.eventName).toBe('Renamed Summit');
      expect((await Event.findByPk(ev.id)).reassessmentFlaggedAt).toBeNull();
    });

    test('a major change (date/time + attendance) updates both rows and flags reassessment', async () => {
      const ev = await fresh();
      const res = await patch(ev, {
        startDatetime: '2027-10-02T10:00:00Z',
        endDatetime: '2027-10-02T18:00:00Z',
        expectedAttendance: 90,
      });
      expect(res.status).toBe(200);
      expect(res.body.changeType).toBe('major');
      expect(res.body.reassessment.required).toBe(true);
      expect(res.body.reassessment.majorFields).toEqual(
        expect.arrayContaining(['startDatetime', 'endDatetime', 'expectedAttendance'])
      );

      const event = await Event.findByPk(ev.id);
      expect(event.startDatetime.toISOString()).toBe('2027-10-02T10:00:00.000Z');
      expect(event.reassessmentFlaggedAt).not.toBeNull();
      const er = await EventRequest.findByPk(ev.eventRequestId);
      expect(er.expectedAttendance).toBe(90);
      expect(er.preferredStart.toISOString()).toBe('2027-10-02T10:00:00.000Z');
    });

    test('a layout change is material and requires reassessment', async () => {
      const ev = await fresh();
      const res = await patch(ev, { layout: 'Theatre' });
      expect(res.status).toBe(200);
      expect(res.body.changeType).toBe('major');
      expect(res.body.reassessment.majorFields).toContain('layout');
    });

    test('major change reports affected venue bookings without altering them', async () => {
      const small = await fx.makeVenue('Small', { capacity: 60 });
      const ev = await fresh();
      const booking = await VenueBooking.create({
        eventId: ev.id,
        venueId: small.id,
        requestedBy: coordinator.id,
        startDatetime: new Date('2027-10-01T09:00:00Z'),
        endDatetime: new Date('2027-10-01T17:00:00Z'),
        expectedAttendance: 50,
        status: 'approved',
      });
      const res = await patch(ev, { expectedAttendance: 100 });
      expect(res.status).toBe(200);
      expect(res.body.reassessment.affectedBookings).toEqual([
        expect.objectContaining({ bookingId: booking.id, reasons: ['capacity'] }),
      ]);
      const after = await VenueBooking.findByPk(booking.id);
      expect(after.status).toBe('approved');
      expect(after.venueId).toBe(small.id);
      // venue staff are told the booking needs reassessment
      const note = await Notification.findOne({
        where: { userId: venueStaff.id, eventId: ev.id, type: 'event_reassessment_required' },
      });
      expect(note).not.toBeNull();
    });

    test('a major change resets technical readiness', async () => {
      const ev = await fresh();
      await ev.update({ technicalReadiness: 'complete' });
      await patch(ev, { equipmentRequirements: 'Two extra microphones' });
      expect((await Event.findByPk(ev.id)).technicalReadiness).toBe('pending');
    });

    test('the organiser is notified of major edits but not ordinary ones', async () => {
      const ev = await fresh();
      await patch(ev, { description: 'Updated description' });
      expect(await Notification.count({ where: { userId: organiser.id, eventId: ev.id } })).toBe(0);
      await patch(ev, { expectedAttendance: 75 });
      expect(await Notification.count({ where: { userId: organiser.id, eventId: ev.id, type: 'event_updated' } })).toBe(1);
    });

    test('registered attendees are notified of every approved planning edit', async () => {
      const ev = await fresh();
      const attendee = await fx.createUser(ROLE_NAMES.ATTENDEE, 'planning-attendee');
      await EventRegistration.create({
        eventId: ev.id, attendeeId: attendee.id, status: 'confirmed', confirmedAt: new Date(),
      });

      const res = await patch(ev, { description: 'Updated arrival instructions' });
      expect(res.status).toBe(200);
      expect(res.body.recipients).toBe(1);
      const notice = await Notification.findOne({
        where: { userId: attendee.id, eventId: ev.id, type: 'event_changed' },
      });
      expect(notice.metadata).toMatchObject({ requiresReconfirmation: false });
      expect(notice.metadata.changes).toEqual([
        expect.objectContaining({ field: 'description', after: 'Updated arrival instructions' }),
      ]);
    });

    test('sending the same values changes nothing and writes no log entry', async () => {
      const ev = await fresh();
      const res = await patch(ev, { expectedAttendance: 50 });
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(false);
      const log = await request(app).get(`/api/events/${ev.id}/change-log`).set(auth(tCoord));
      expect(log.body.count).toBe(0);
    });
  });

  describe('role restrictions', () => {
    test('only the assigned Event Coordinator may edit', async () => {
      const ev = await fresh();
      expect((await patch(ev, { eventName: 'X' }, tOther)).status).toBe(403);
      for (const token of [tOrg, tLead, tTech, tVenue]) {
        expect((await patch(ev, { eventName: 'X' }, token)).status).toBe(403);
      }
      expect((await request(app).patch(`/api/events/${ev.id}`).send({ eventName: 'X' })).status).toBe(401);
      expect((await EventRequest.findByPk(ev.eventRequestId)).eventName).not.toBe('X');
    });

    test('404 for an unknown event', async () => {
      const res = await request(app)
        .patch('/api/events/00000000-0000-4000-8000-000000000000')
        .set(auth(tCoord))
        .send({ eventName: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('validation and guards', () => {
    test('rejects bad input', async () => {
      const ev = await fresh();
      expect((await patch(ev, {})).status).toBe(400);
      expect((await patch(ev, { status: 'cancelled' })).status).toBe(400); // not editable here
      expect((await patch(ev, { expectedAttendance: 0 })).status).toBe(400);
      expect((await patch(ev, { eventName: '   ' })).status).toBe(400);
      expect((await patch(ev, { startDatetime: 'not-a-date' })).status).toBe(400);
      expect((await patch(ev, { startDatetime: '2027-10-01T18:00:00Z' })).status).toBe(400); // after existing end
    });

    test('completed and cancelled events cannot be changed', async () => {
      for (const status of ['completed', 'cancelled']) {
        const ev = await fresh('2027-10-05T09:00:00Z', '2027-10-05T12:00:00Z', { status });
        expect((await patch(ev, { eventName: 'Nope' })).status).toBe(409);
      }
    });

    test('moving to a time that clashes with the event venue is refused', async () => {
      const hall = await fx.makeVenue('Clash Hall');
      const ev = await fresh('2027-10-10T09:00:00Z', '2027-10-10T12:00:00Z', { venue: hall });
      await fx.makeEvent({
        organiser, coordinator, venue: hall, start: '2027-10-11T09:00:00Z', end: '2027-10-11T12:00:00Z',
      });
      const res = await patch(ev, { startDatetime: '2027-10-11T10:00:00Z', endDatetime: '2027-10-11T13:00:00Z' });
      expect(res.status).toBe(409);
      expect(res.body.conflicts.length).toBeGreaterThan(0);
      expect((await Event.findByPk(ev.id)).startDatetime.toISOString()).toBe('2027-10-10T09:00:00.000Z');
    });
  });

  describe('change history', () => {
    test('every applied change is preserved with old and new values', async () => {
      const ev = await fresh();
      await patch(ev, { eventName: 'First' });
      await patch(ev, { expectedAttendance: 80, reason: 'More sign-ups' });
      const res = await request(app).get(`/api/events/${ev.id}/change-log`).set(auth(tCoord));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      const [latest, earliest] = res.body.entries;
      expect(latest.changeType).toBe('major');
      expect(latest.changes.expectedAttendance).toEqual({ from: 50, to: 80 });
      expect(latest.reason).toBe('More sign-ups');
      expect(latest.source).toBe('coordinator_update');
      expect(earliest.changeType).toBe('ordinary');
      expect(earliest.changer.id).toBe(coordinator.id);
    });

    test('visible to stakeholders only', async () => {
      const ev = await fresh();
      for (const token of [tCoord, tLead, tOrg, tVenue, tTech]) {
        expect((await request(app).get(`/api/events/${ev.id}/change-log`).set(auth(token))).status).toBe(200);
      }
      for (const token of [tOther, tOtherOrg]) {
        expect((await request(app).get(`/api/events/${ev.id}/change-log`).set(auth(token))).status).toBe(403);
      }
    });
  });
});
