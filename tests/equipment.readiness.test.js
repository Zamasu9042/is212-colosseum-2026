// SCRUM-24: Reserve Equipment for Approved Event Window — integration tests.
// Needs a database with schema.sql applied (npm run db:init && npm run db:seed).
const { sequelize, ROLE_NAMES, Event } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('s24');

describe('SCRUM-24 Reserve Equipment for Approved Event Window', () => {
  let tech, coordinator, otherCoordinator, organiser, techToken, coordToken, otherCoordToken;
  let northHall, southHall;

  const reserve = (ev, body) =>
    request(app).post(`/api/events/${ev.id}/equipment-reservations`).set(auth(techToken)).send(body);
  const addLine = (ev, body, token = coordToken) =>
    request(app).post(`/api/events/${ev.id}/equipment-requests`).set(auth(token)).send(body);
  const setReady = (ev, complete) =>
    request(app).patch(`/api/events/${ev.id}/technical-readiness`).set(auth(techToken)).send({ complete });

  beforeAll(async () => {
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    [techToken, coordToken, otherCoordToken] = await Promise.all([tech, coordinator, otherCoordinator].map(fx.login));
    // Two venues far apart, each with a 60-minute setup/turnaround buffer.
    northHall = await fx.makeVenue('North Hall', { location: 'Jurong East' });
    southHall = await fx.makeVenue('South Hall', { location: 'Changi' });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('AC1 — reservations overlapping existing event time-slots are blocked', () => {
    test('same item, overlapping slots at different venues -> 409', async () => {
      const item = await fx.makeEquipment('Overlap');
      const a = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-09-01T09:00:00Z', end: '2027-09-01T12:00:00Z' });
      const b = await fx.makeEvent({ organiser, coordinator, venue: southHall, start: '2027-09-01T11:59:00Z', end: '2027-09-01T14:00:00Z' });
      expect((await reserve(a, { equipmentId: item.id })).status).toBe(201);
      const res = await reserve(b, { equipmentId: item.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EQUIPMENT_RESERVATION_CONFLICT');
    });

    test('identical slot -> 409', async () => {
      const item = await fx.makeEquipment('Identical');
      const a = await fx.makeEvent({ organiser, coordinator, start: '2027-09-02T09:00:00Z', end: '2027-09-02T12:00:00Z' });
      const b = await fx.makeEvent({ organiser, coordinator, start: '2027-09-02T09:00:00Z', end: '2027-09-02T12:00:00Z' });
      await reserve(a, { equipmentId: item.id });
      expect((await reserve(b, { equipmentId: item.id })).status).toBe(409);
    });
  });

  describe('AC2 — no transit or buffer time between different venue locations', () => {
    test('back-to-back events at venues across the island can share one item', async () => {
      const item = await fx.makeEquipment('BackToBack');
      const a = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-09-03T09:00:00Z', end: '2027-09-03T12:00:00Z' });
      const b = await fx.makeEvent({ organiser, coordinator, venue: southHall, start: '2027-09-03T12:00:00Z', end: '2027-09-03T15:00:00Z' });
      expect((await reserve(a, { equipmentId: item.id })).status).toBe(201);
      const res = await reserve(b, { equipmentId: item.id });
      expect(res.status).toBe(201);
    });

    test("venue setup/turnaround minutes are not applied to equipment", async () => {
      // North Hall has 60 min turnaround; a venue booking would need a gap.
      const item = await fx.makeEquipment('NoVenueBuffer');
      const a = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-09-04T09:00:00Z', end: '2027-09-04T10:00:00Z' });
      const b = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-09-04T10:00:00Z', end: '2027-09-04T11:00:00Z' });
      await reserve(a, { equipmentId: item.id });
      expect((await reserve(b, { equipmentId: item.id })).status).toBe(201);
    });

    test('the selectable list agrees: item is free right after the previous slot ends', async () => {
      const item = await fx.makeEquipment('ListAgrees', { type: `S24LIST-${fx.suffix}` });
      const a = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-09-05T09:00:00Z', end: '2027-09-05T12:00:00Z' });
      await reserve(a, { equipmentId: item.id });
      const res = await request(app)
        .get(`/api/equipment?selectable=true&type=S24LIST-${fx.suffix}&startDatetime=2027-09-05T12:00:00Z&endDatetime=2027-09-05T13:00:00Z`)
        .set(auth(techToken));
      expect(res.body.equipment.map((e) => e.id)).toEqual([item.id]);
    });
  });

  describe('AC3 — technical readiness requires full equipment allocation', () => {
    let event, projectors, mic, line1, line2;

    beforeAll(async () => {
      event = await fx.makeEvent({ organiser, coordinator, venue: northHall, start: '2027-10-01T09:00:00Z', end: '2027-10-01T17:00:00Z' });
      projectors = [
        await fx.makeEquipment('Projector A', { type: 'Projector' }),
        await fx.makeEquipment('Projector B', { type: 'Projector' }),
      ];
      mic = await fx.makeEquipment('Mic Set', { type: 'Audio', quantityTotal: 4, quantityAvailable: 4 });
      line1 = (await addLine(event, { equipmentType: 'Projector', quantityRequested: 2, technicalRequirements: 'HDMI' })).body.equipmentRequest;
      line2 = (await addLine(event, { equipmentId: mic.id, quantityRequested: 2 })).body.equipmentRequest;
    });

    test('request lines are recorded; a pinned line takes the item type', () => {
      expect(line1).toMatchObject({ equipmentType: 'Projector', quantityRequested: 2, technicalRequirements: 'HDMI' });
      expect(line2).toMatchObject({ equipmentType: 'Audio', equipmentId: mic.id });
    });

    test('with nothing allocated, readiness cannot be completed', async () => {
      const res = await setReady(event, true);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EQUIPMENT_NOT_FULLY_ALLOCATED');
      expect(res.body.error).toMatch(/Projector: 0\/2; Audio: 0\/2/);
      expect((await Event.findByPk(event.id)).technicalReadiness).toBe('pending');
    });

    test('partial allocation still blocks completion', async () => {
      expect((await reserve(event, { equipmentId: projectors[0].id, equipmentRequestId: line1.id })).status).toBe(201);
      expect((await reserve(event, { equipmentId: mic.id, quantity: 2, equipmentRequestId: line2.id })).status).toBe(201);
      const res = await setReady(event, true);
      expect(res.status).toBe(409);
      expect(res.body.summary.outstanding).toHaveLength(1);
      expect(res.body.summary.outstanding[0]).toMatchObject({ equipmentType: 'Projector', quantityAllocated: 1, shortfall: 1 });
      const status = await request(app).get(`/api/events/${event.id}/technical-readiness`).set(auth(coordToken));
      expect(status.body).toMatchObject({ technicalReadiness: 'pending', canComplete: false });
    });

    test('a reservation must match the line (type, pinned item, remaining quantity)', async () => {
      const wrongType = await reserve(event, { equipmentId: mic.id, equipmentRequestId: line1.id });
      expect(wrongType.status).toBe(422);
      expect(wrongType.body.error).toMatch(/needs Projector equipment/);
      const otherMic = await fx.makeEquipment('Other Mic', { type: 'Audio' });
      const wrongPin = await reserve(event, { equipmentId: otherMic.id, equipmentRequestId: line2.id });
      expect(wrongPin.status).toBe(422);
      expect(wrongPin.body.error).toMatch(/pinned/);
      const overAllocate = await reserve(event, { equipmentId: mic.id, quantity: 1, equipmentRequestId: line2.id });
      expect(overAllocate.status).toBe(422);
      expect(overAllocate.body.error).toMatch(/already fully allocated/);
    });

    test('a line from another event is rejected', async () => {
      const other = await fx.makeEvent({ organiser, coordinator, start: '2027-10-01T09:00:00Z', end: '2027-10-01T17:00:00Z' });
      const res = await reserve(other, { equipmentId: projectors[1].id, equipmentRequestId: line1.id });
      expect(res.status).toBe(422);
    });

    test('once every line is fully allocated, readiness can be completed', async () => {
      expect((await reserve(event, { equipmentId: projectors[1].id, equipmentRequestId: line1.id })).status).toBe(201);
      const res = await setReady(event, true);
      expect(res.status).toBe(200);
      expect(res.body.technicalReadiness).toBe('complete');
      expect(res.body.allocation.fullyAllocated).toBe(true);
      const detail = await request(app).get(`/api/events/${event.id}`).set(auth(techToken));
      expect(detail.body.event.technicalReadiness).toBe('complete');
      expect(detail.body.equipmentAllocation.totalAllocated).toBe(4);
    });

    test('cancelling an allocated reservation sends readiness back to pending', async () => {
      const list = await request(app).get(`/api/events/${event.id}/equipment-reservations`).set(auth(techToken));
      const projectorRes = list.body.activeReservations.find((r) => r.equipmentId === projectors[1].id);
      const res = await request(app).post(`/api/equipment-reservations/${projectorRes.id}/cancel`).set(auth(techToken)).send({});
      expect(res.body.readinessReverted).toBe(true);
      expect((await Event.findByPk(event.id)).technicalReadiness).toBe('pending');
      // Re-allocate and complete again.
      await reserve(event, { equipmentId: projectors[1].id, equipmentRequestId: line1.id });
      expect((await setReady(event, true)).status).toBe(200);
    });

    test('adding a new request line sends readiness back to pending', async () => {
      await addLine(event, { equipmentType: 'Projector', quantityRequested: 1 });
      expect((await Event.findByPk(event.id)).technicalReadiness).toBe('pending');
      const lines = await request(app).get(`/api/events/${event.id}/equipment-requests`).set(auth(coordToken));
      expect(lines.body.equipmentRequests).toHaveLength(3);
      expect(lines.body.allocation.fullyAllocated).toBe(false);
    });

    test('a line with active reservations cannot be deleted; an unallocated one can', async () => {
      const blocked = await request(app).delete(`/api/events/${event.id}/equipment-requests/${line1.id}`).set(auth(coordToken));
      expect(blocked.status).toBe(409);
      const lines = await request(app).get(`/api/events/${event.id}/equipment-requests`).set(auth(coordToken));
      const extra = lines.body.equipmentRequests.find((l) => l.allocation.quantityAllocated === 0);
      const ok = await request(app).delete(`/api/events/${event.id}/equipment-requests/${extra.id}`).set(auth(coordToken));
      expect(ok.status).toBe(200);
      expect(ok.body.allocation.fullyAllocated).toBe(true);
      expect((await setReady(event, true)).status).toBe(200);
    });

    test('readiness can be reset to pending explicitly', async () => {
      const res = await setReady(event, false);
      expect(res.status).toBe(200);
      expect(res.body.technicalReadiness).toBe('pending');
    });

    test('an event with no equipment requested can be marked ready', async () => {
      const bare = await fx.makeEvent({ organiser, coordinator, start: '2027-10-02T09:00:00Z', end: '2027-10-02T10:00:00Z' });
      const res = await setReady(bare, true);
      expect(res.status).toBe(200);
      expect(res.body.allocation.lines).toEqual([]);
    });

    test('cancelled events cannot be marked ready', async () => {
      const cancelled = await fx.makeEvent({ organiser, coordinator, status: 'cancelled', start: '2027-10-03T09:00:00Z', end: '2027-10-03T10:00:00Z' });
      expect((await setReady(cancelled, true)).status).toBe(409);
    });
  });

  describe('permissions & validation', () => {
    let event;
    beforeAll(async () => {
      event = await fx.makeEvent({ organiser, coordinator, start: '2027-11-01T09:00:00Z', end: '2027-11-01T10:00:00Z' });
    });

    test('only Technical Support Staff can mark readiness', async () => {
      const res = await request(app).patch(`/api/events/${event.id}/technical-readiness`).set(auth(coordToken)).send({ complete: true });
      expect(res.status).toBe(403);
    });

    test("another coordinator cannot add lines to or read this event's requests", async () => {
      expect((await addLine(event, { equipmentType: 'AV', quantityRequested: 1 }, otherCoordToken)).status).toBe(403);
      const res = await request(app).get(`/api/events/${event.id}/technical-readiness`).set(auth(otherCoordToken));
      expect(res.status).toBe(403);
    });

    test('Technical Support Staff can also record request lines', async () => {
      expect((await addLine(event, { equipmentType: 'AV', quantityRequested: 1 }, techToken)).status).toBe(201);
    });

    test('invalid lines are rejected', async () => {
      expect((await addLine(event, { equipmentType: 'AV', quantityRequested: 0 })).status).toBe(400);
      expect((await addLine(event, { quantityRequested: 1 })).status).toBe(400);
      expect((await addLine(event, { equipmentId: '00000000-0000-4000-8000-000000000000', quantityRequested: 1 })).status).toBe(422);
      expect((await setReady(event, 'maybe')).status).toBe(400);
    });

    test('unknown event is a 404', async () => {
      const missing = { id: '00000000-0000-4000-8000-000000000000' };
      expect((await setReady(missing, true)).status).toBe(404);
      expect((await addLine(missing, { equipmentType: 'AV', quantityRequested: 1 })).status).toBe(404);
    });
  });
});
