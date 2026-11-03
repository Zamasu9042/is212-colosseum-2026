// Request Changes to a Submitted Event — integration tests.
const { sequelize, ROLE_NAMES, Event, EventRequest, EventChangeLog, EventChangeRequest, Notification } =
  require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('chg');

describe('Request Changes to a Submitted Event', () => {
  let coordinator, otherCoordinator, lead, organiser, otherOrganiser, tech;
  let tCoord, tOther, tLead, tOrg, tOtherOrg, tTech;

  const submit = (ev, body, token = tOrg) =>
    request(app).post(`/api/events/${ev.id}/change-requests`).set(auth(token)).send(body);
  const fresh = (start = '2027-11-01T09:00:00Z', end = '2027-11-01T17:00:00Z', extra = {}) =>
    fx.makeEvent({ organiser, coordinator, start, end, ...extra });
  const decide = (cr, action, body = {}, token = tCoord) =>
    request(app).post(`/api/event-change-requests/${cr.id}/${action}`).set(auth(token)).send(body);

  beforeAll(async () => {
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    lead = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    otherOrganiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org2');
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    [tCoord, tOther, tLead, tOrg, tOtherOrg, tTech] = await Promise.all(
      [coordinator, otherCoordinator, lead, organiser, otherOrganiser, tech].map(fx.login)
    );
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('submitting a change request', () => {
    test('organiser can request date/time, attendance, venue and equipment changes; coordinator is notified', async () => {
      const ev = await fresh();
      const res = await submit(ev, {
        startDatetime: '2027-11-02T09:00:00Z',
        endDatetime: '2027-11-02T17:00:00Z',
        expectedAttendance: 120,
        venueRequirements: 'Larger hall with stage',
        equipmentRequirements: 'Four wireless microphones',
        reason: 'More registrations than expected',
      });
      expect(res.status).toBe(201);
      expect(res.body.changeRequest.status).toBe('pending');
      expect(res.body.isMajor).toBe(true);
      expect(Object.keys(res.body.changeRequest.proposedChanges)).toEqual(
        expect.arrayContaining([
          'startDatetime', 'endDatetime', 'expectedAttendance', 'venueRequirements', 'equipmentRequirements',
        ])
      );
      expect(res.body.changeRequest.currentValues.expectedAttendance).toBe(50);

      // nothing has changed yet
      expect((await EventRequest.findByPk(ev.eventRequestId)).expectedAttendance).toBe(50);
      expect((await Event.findByPk(ev.id)).startDatetime.toISOString()).toBe('2027-11-01T09:00:00.000Z');

      const note = await Notification.findOne({
        where: { userId: coordinator.id, eventId: ev.id, type: 'event_change_requested' },
      });
      expect(note).not.toBeNull();
    });

    test('only the organiser who owns the event may request', async () => {
      const ev = await fresh();
      expect((await submit(ev, { expectedAttendance: 60 }, tOtherOrg)).status).toBe(403);
      for (const token of [tCoord, tLead, tTech]) {
        expect((await submit(ev, { expectedAttendance: 60 }, token)).status).toBe(403);
      }
      expect(await EventChangeRequest.count({ where: { eventId: ev.id } })).toBe(0);
    });

    test('validation: empty, unchanged, invalid, and backwards windows are rejected', async () => {
      const ev = await fresh();
      expect((await submit(ev, {})).status).toBe(400);
      expect((await submit(ev, { eventName: 'Not requestable' })).status).toBe(400);
      expect((await submit(ev, { expectedAttendance: 50 })).status).toBe(422); // same as today
      expect((await submit(ev, { expectedAttendance: -3 })).status).toBe(400);
      expect((await submit(ev, { startDatetime: 'tomorrow-ish' })).status).toBe(400);
      expect((await submit(ev, { startDatetime: '2027-11-01T18:00:00Z' })).status).toBe(400);
    });

    test('only one pending request per event; completed/cancelled events refused', async () => {
      const ev = await fresh();
      expect((await submit(ev, { expectedAttendance: 60 })).status).toBe(201);
      const second = await submit(ev, { expectedAttendance: 70 });
      expect(second.status).toBe(409);

      const cancelled = await fresh('2027-11-05T09:00:00Z', '2027-11-05T12:00:00Z', { status: 'cancelled' });
      expect((await submit(cancelled, { expectedAttendance: 60 })).status).toBe(409);
    });
  });

  describe('viewing', () => {
    test('coordinator queue shows own events only; organiser sees own; others blocked', async () => {
      const ev = await fresh();
      const cr = (await submit(ev, { expectedAttendance: 65 })).body.changeRequest;

      const mine = await request(app).get('/api/event-change-requests').set(auth(tCoord));
      expect(mine.status).toBe(200);
      expect(mine.body.changeRequests.map((c) => c.id)).toContain(cr.id);

      const theirs = await request(app).get('/api/event-change-requests').set(auth(tOther));
      expect(theirs.body.changeRequests.map((c) => c.id)).not.toContain(cr.id);

      const org = await request(app).get('/api/event-change-requests').set(auth(tOrg));
      expect(org.body.changeRequests.map((c) => c.id)).toContain(cr.id);
      const otherOrg = await request(app).get('/api/event-change-requests').set(auth(tOtherOrg));
      expect(otherOrg.body.changeRequests.map((c) => c.id)).not.toContain(cr.id);

      expect((await request(app).get('/api/event-change-requests').set(auth(tTech))).status).toBe(403);

      const perEvent = await request(app).get(`/api/events/${ev.id}/change-requests`).set(auth(tCoord));
      expect(perEvent.body.count).toBe(1);
      expect((await request(app).get(`/api/events/${ev.id}/change-requests`).set(auth(tOtherOrg))).status).toBe(403);
      expect((await request(app).get(`/api/events/${ev.id}/change-requests`).set(auth(tOther))).status).toBe(403);
    });
  });

  describe('coordinator decision', () => {
    test('approving applies the change, logs it, flags reassessment and notifies the organiser', async () => {
      const ev = await fresh();
      const cr = (await submit(ev, {
        startDatetime: '2027-11-03T09:00:00Z',
        endDatetime: '2027-11-03T17:00:00Z',
        expectedAttendance: 110,
        reason: 'Date clash with exams',
      })).body.changeRequest;

      const res = await decide(cr, 'approve', { reviewReason: 'Fine by us' });
      expect(res.status).toBe(200);
      expect(res.body.changeType).toBe('major');
      expect(res.body.reassessment.required).toBe(true);

      const event = await Event.findByPk(ev.id);
      expect(event.startDatetime.toISOString()).toBe('2027-11-03T09:00:00.000Z');
      expect(event.reassessmentFlaggedAt).not.toBeNull();
      expect((await EventRequest.findByPk(ev.eventRequestId)).expectedAttendance).toBe(110);

      const stored = await EventChangeRequest.findByPk(cr.id);
      expect(stored.status).toBe('approved');
      expect(stored.reviewedBy).toBe(coordinator.id);

      const log = await EventChangeLog.findOne({ where: { eventId: ev.id } });
      expect(log.source).toBe('change_request');
      expect(log.changeRequestId).toBe(cr.id);
      expect(log.changes.expectedAttendance).toEqual({ from: 50, to: 110 });

      const note = await Notification.findOne({
        where: { userId: organiser.id, eventId: ev.id, type: 'event_change_approved' },
      });
      expect(note).not.toBeNull();

      // a decided request cannot be decided again
      expect((await decide(cr, 'approve')).status).toBe(409);
      expect((await decide(cr, 'reject', { reviewReason: 'late' })).status).toBe(409);
    });

    test('rejecting needs a reason, leaves the event untouched and notifies the organiser', async () => {
      const ev = await fresh();
      const cr = (await submit(ev, { expectedAttendance: 400 })).body.changeRequest;

      expect((await decide(cr, 'reject', {})).status).toBe(400);
      const res = await decide(cr, 'reject', { reviewReason: 'No venue can hold that many' });
      expect(res.status).toBe(200);
      expect(res.body.changeRequest.status).toBe('rejected');

      expect((await EventRequest.findByPk(ev.eventRequestId)).expectedAttendance).toBe(50);
      expect(await EventChangeLog.count({ where: { eventId: ev.id } })).toBe(0);
      const note = await Notification.findOne({
        where: { userId: organiser.id, eventId: ev.id, type: 'event_change_rejected' },
      });
      expect(note.message).toMatch(/No venue can hold that many/);

      // after a decision a new request is allowed again
      expect((await submit(ev, { expectedAttendance: 90 })).status).toBe(201);
    });

    test('only the assigned coordinator may decide', async () => {
      const ev = await fresh();
      const cr = (await submit(ev, { expectedAttendance: 61 })).body.changeRequest;
      expect((await decide(cr, 'approve', {}, tOther)).status).toBe(403);
      expect((await decide(cr, 'reject', { reviewReason: 'x' }, tOther)).status).toBe(403);
      for (const token of [tOrg, tLead, tTech]) {
        expect((await decide(cr, 'approve', {}, token)).status).toBe(403);
      }
      expect((await EventChangeRequest.findByPk(cr.id)).status).toBe('pending');
    });

    test('approval that would clash with the venue schedule is blocked and stays pending', async () => {
      const hall = await fx.makeVenue('Change Hall');
      const ev = await fresh('2027-11-10T09:00:00Z', '2027-11-10T12:00:00Z', { venue: hall });
      await fx.makeEvent({
        organiser, coordinator, venue: hall, start: '2027-11-11T09:00:00Z', end: '2027-11-11T12:00:00Z',
      });
      const cr = (await submit(ev, {
        startDatetime: '2027-11-11T10:00:00Z',
        endDatetime: '2027-11-11T13:00:00Z',
      })).body.changeRequest;

      const res = await decide(cr, 'approve');
      expect(res.status).toBe(409);
      expect((await EventChangeRequest.findByPk(cr.id)).status).toBe('pending');
      expect((await Event.findByPk(ev.id)).startDatetime.toISOString()).toBe('2027-11-10T09:00:00.000Z');
      expect(await EventChangeLog.count({ where: { eventId: ev.id } })).toBe(0);
    });
  });

  describe('withdrawing', () => {
    test('the organiser can withdraw a pending request; others cannot; coordinator can no longer approve it', async () => {
      const ev = await fresh();
      const cr = (await submit(ev, { expectedAttendance: 55 })).body.changeRequest;

      expect((await request(app).post(`/api/event-change-requests/${cr.id}/withdraw`).set(auth(tOtherOrg))).status).toBe(403);
      const res = await request(app).post(`/api/event-change-requests/${cr.id}/withdraw`).set(auth(tOrg));
      expect(res.status).toBe(200);
      expect(res.body.changeRequest.status).toBe('withdrawn');

      expect((await decide(cr, 'approve')).status).toBe(409);
      expect((await request(app).post(`/api/event-change-requests/${cr.id}/withdraw`).set(auth(tOrg))).status).toBe(409);
    });
  });
});