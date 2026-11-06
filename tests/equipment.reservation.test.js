// SCRUM-21: Reserve Equipment for an Event — integration tests.
// Needs a database with schema.sql applied (npm run db:init && npm run db:seed).
const { sequelize, ROLE_NAMES, Equipment, Notification, EventRequest, Event } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('s21');

describe('SCRUM-21 Reserve Equipment for an Event', () => {
  let tech, coordinator, otherCoordinator, organiser, lead;
  let techToken, coordToken, otherCoordToken, leadToken;
  let event;

  const reserve = (ev, body, token = techToken) =>
    request(app).post(`/api/events/${ev.id}/equipment-reservations`).set(auth(token)).send(body);

  beforeAll(async () => {
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org', { firstName: 'Jane', lastName: 'Tan' });
    lead = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead');
    [techToken, coordToken, otherCoordToken, leadToken] = await Promise.all(
      [tech, coordinator, otherCoordinator, lead].map(fx.login)
    );
    event = await fx.makeEvent({
      organiser, coordinator, name: `Leadership Summit ${fx.suffix}`,
      start: '2027-07-01T09:00:00Z', end: '2027-07-01T17:00:00Z',
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe("AC1 — status changes from available to reserved for an approved event's time window", () => {
    test('reserving flips the item to reserved and uses the event window by default', async () => {
      const item = await fx.makeEquipment('Projector');
      expect(item.status).toBe('available');
      const res = await reserve(event, { equipmentId: item.id });
      expect(res.status).toBe(201);
      expect(res.body.equipment.status).toBe('reserved');
      expect(new Date(res.body.reservation.startDatetime).toISOString()).toBe('2027-07-01T09:00:00.000Z');
      expect(new Date(res.body.reservation.endDatetime).toISOString()).toBe('2027-07-01T17:00:00.000Z');
      expect((await Equipment.findByPk(item.id)).status).toBe('reserved');
    });

    test('a slot inside the event window is accepted', async () => {
      const item = await fx.makeEquipment('Mic');
      const res = await reserve(event, {
        equipmentId: item.id, startDatetime: '2027-07-01T13:00:00Z', endDatetime: '2027-07-01T15:00:00Z',
      });
      expect(res.status).toBe(201);
    });

    test('a window outside the approved event window is rejected', async () => {
      const item = await fx.makeEquipment('Outside');
      const res = await reserve(event, {
        equipmentId: item.id, startDatetime: '2027-07-01T08:00:00Z', endDatetime: '2027-07-01T10:00:00Z',
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/within the approved event/);
      expect((await Equipment.findByPk(item.id)).status).toBe('available');
    });

    test('end before start is rejected', async () => {
      const item = await fx.makeEquipment('Backwards');
      const res = await reserve(event, {
        equipmentId: item.id, startDatetime: '2027-07-01T12:00:00Z', endDatetime: '2027-07-01T11:00:00Z',
      });
      expect(res.status).toBe(422);
    });

    test.each(['cancelled', 'completed'])('a %s event cannot have equipment reserved', async (status) => {
      const ev = await fx.makeEvent({
        organiser, coordinator, status, start: '2027-07-02T09:00:00Z', end: '2027-07-02T10:00:00Z',
      });
      const item = await fx.makeEquipment(`For ${status}`);
      const res = await reserve(ev, { equipmentId: item.id });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/approved event/);
    });

    test('confirmed and awaiting_arrangements events can be reserved for', async () => {
      for (const status of ['confirmed', 'awaiting_arrangements']) {
        const ev = await fx.makeEvent({
          organiser, coordinator, status, start: '2027-07-03T09:00:00Z', end: '2027-07-03T10:00:00Z',
        });
        const item = await fx.makeEquipment(`For ${status}`);
        expect((await reserve(ev, { equipmentId: item.id })).status).toBe(201);
      }
    });

    test('unknown event or equipment is a 404; bad ids a 400', async () => {
      const item = await fx.makeEquipment('404');
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await reserve({ id: missing }, { equipmentId: item.id })).status).toBe(404);
      expect((await reserve(event, { equipmentId: missing })).status).toBe(404);
      expect((await reserve(event, { equipmentId: 'nope' })).status).toBe(400);
    });

    test('cannot reserve more units than the item has in service', async () => {
      const item = await fx.makeEquipment('Pair', { quantityTotal: 2, quantityAvailable: 2 });
      const res = await reserve(event, { equipmentId: item.id, quantity: 3 });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/Only 2 unit/);
    });
  });

  describe('AC2 — overlapping reservations are prevented with a conflict message', () => {
    let item, other;
    beforeAll(async () => {
      item = await fx.makeEquipment('Contested');
      other = await fx.makeEvent({
        organiser, coordinator, name: `Product Launch ${fx.suffix}`,
        start: '2027-07-01T16:00:00Z', end: '2027-07-01T20:00:00Z',
      });
      expect((await reserve(event, { equipmentId: item.id })).status).toBe(201);
    });

    test('overlapping event gets 409 with the conflicting reservation listed', async () => {
      const res = await reserve(other, { equipmentId: item.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EQUIPMENT_RESERVATION_CONFLICT');
      expect(res.body.error).toMatch(/already reserved for an overlapping time window/);
      expect(res.body.error).toContain(`Leadership Summit ${fx.suffix}`);
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0]).toMatchObject({ eventId: event.id, quantity: 1 });
      expect(res.body.availableQuantity).toBe(0);
    });

    test('a non-overlapping slot of the same item is allowed', async () => {
      const res = await reserve(other, {
        equipmentId: item.id, startDatetime: '2027-07-01T17:00:00Z', endDatetime: '2027-07-01T20:00:00Z',
      });
      expect(res.status).toBe(201);
    });

    test('multi-unit items only conflict when quantity runs out', async () => {
      const chairs = await fx.makeEquipment('Chairs', { type: 'Furniture', quantityTotal: 10, quantityAvailable: 10 });
      expect((await reserve(event, { equipmentId: chairs.id, quantity: 6 })).status).toBe(201);
      expect((await reserve(other, { equipmentId: chairs.id, quantity: 4 })).status).toBe(201);
      const res = await reserve(other, { equipmentId: chairs.id, quantity: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/0 of 10 unit\(s\) free/);
    });

    test('concurrent requests for the last unit: exactly one wins', async () => {
      const last = await fx.makeEquipment('LastOne');
      const [a, b, c] = await Promise.all([
        reserve(event, { equipmentId: last.id }),
        reserve(other, { equipmentId: last.id }),
        reserve(event, { equipmentId: last.id }),
      ]);
      const statuses = [a.status, b.status, c.status].sort();
      expect(statuses).toEqual([201, 409, 409]);
    });
  });

  describe('AC3 — each reservation carries event ID, equipment ID, organiser name and timestamp', () => {
    test('metadata is stored and returned', async () => {
      const item = await fx.makeEquipment('Meta');
      const before = Date.now();
      const res = await reserve(event, { equipmentId: item.id });
      expect(res.status).toBe(201);
      const r = res.body.reservation;
      expect(r.eventId).toBe(event.id);
      expect(r.equipmentId).toBe(item.id);
      expect(r.organiserName).toBe('Jane Tan');
      expect(new Date(r.reservedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(r.reservedBy.id).toBe(tech.id);
      expect(r.eventName).toBe(`Leadership Summit ${fx.suffix}`);
      expect(r.equipmentName).toBe(item.name);
    });

    test("the event's coordinator is notified", async () => {
      const notes = await Notification.findAll({ where: { userId: coordinator.id, type: 'equipment_reserved', eventId: event.id } });
      expect(notes.length).toBeGreaterThan(0);
    });
  });

  describe('AC4 — reservations appear on the event detail page and the equipment detail page', () => {
    let item, reservationId;
    beforeAll(async () => {
      item = await fx.makeEquipment('Shown');
      reservationId = (await reserve(event, { equipmentId: item.id })).body.reservation.id;
    });

    test('event detail (GET /events/:id) lists it', async () => {
      const res = await request(app).get(`/api/events/${event.id}`).set(auth(techToken));
      expect(res.status).toBe(200);
      expect(res.body.equipmentReservations.map((r) => r.id)).toContain(reservationId);
    });

    test('event reservations endpoint lists it', async () => {
      const res = await request(app).get(`/api/events/${event.id}/equipment-reservations`).set(auth(coordToken));
      expect(res.status).toBe(200);
      expect(res.body.activeReservations.map((r) => r.id)).toContain(reservationId);
    });

    test('equipment detail (GET /equipment/:id) lists it', async () => {
      const res = await request(app).get(`/api/equipment/${item.id}`).set(auth(techToken));
      expect(res.status).toBe(200);
      expect(res.body.equipment.status).toBe('reserved');
      expect(res.body.reservations).toHaveLength(1);
      expect(res.body.reservations[0]).toMatchObject({ id: reservationId, eventId: event.id, organiserName: 'Jane Tan' });
    });

    test("another coordinator cannot see this event's reservations", async () => {
      const res = await request(app).get(`/api/events/${event.id}/equipment-reservations`).set(auth(otherCoordToken));
      expect(res.status).toBe(403);
      const detail = await request(app).get(`/api/events/${event.id}`).set(auth(otherCoordToken));
      expect(detail.status).toBe(403);
    });

    test('cross-event list can be filtered by equipment', async () => {
      const res = await request(app).get(`/api/equipment-reservations?equipmentId=${item.id}`).set(auth(leadToken));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    test('event list is available to Technical Support Staff; coordinators see only their own', async () => {
      const techList = await request(app).get('/api/events').set(auth(techToken));
      expect(techList.status).toBe(200);
      expect(techList.body.events.map((e) => e.id)).toContain(event.id);
      const otherList = await request(app).get('/api/events').set(auth(otherCoordToken));
      expect(otherList.body.events.map((e) => e.id)).not.toContain(event.id);
    });
  });

  describe('AC5 — cancelling reverts the item from reserved to available', () => {
    test('cancel -> available, reservation kept as cancelled with who/when/why', async () => {
      const item = await fx.makeEquipment('Cancel');
      const { reservation } = (await reserve(event, { equipmentId: item.id })).body;
      const res = await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`)
        .set(auth(techToken)).send({ reason: 'Organiser no longer needs it' });
      expect(res.status).toBe(200);
      expect(res.body.equipment.status).toBe('available');
      expect(res.body.reservation).toMatchObject({ status: 'cancelled', cancellationReason: 'Organiser no longer needs it' });
      expect(res.body.reservation.cancelledBy.id).toBe(tech.id);
      expect((await Equipment.findByPk(item.id)).status).toBe('available');
    });

    test('item stays reserved while another live reservation remains', async () => {
      const item = await fx.makeEquipment('TwoSlots');
      const a = (await reserve(event, { equipmentId: item.id, startDatetime: '2027-07-01T09:00:00Z', endDatetime: '2027-07-01T10:00:00Z' })).body.reservation;
      await reserve(event, { equipmentId: item.id, startDatetime: '2027-07-01T11:00:00Z', endDatetime: '2027-07-01T12:00:00Z' });
      const res = await request(app).post(`/api/equipment-reservations/${a.id}/cancel`).set(auth(techToken)).send({});
      expect(res.body.equipment.status).toBe('reserved');
    });

    test('a cancelled slot can be booked by another event', async () => {
      const item = await fx.makeEquipment('Rebook');
      const other = await fx.makeEvent({ organiser, coordinator, start: '2027-07-01T09:00:00Z', end: '2027-07-01T12:00:00Z' });
      const { reservation } = (await reserve(event, { equipmentId: item.id })).body;
      expect((await reserve(other, { equipmentId: item.id })).status).toBe(409);
      await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`).set(auth(techToken)).send({});
      expect((await reserve(other, { equipmentId: item.id })).status).toBe(201);
    });

    test('a cancelled in-repair item stays in repair', async () => {
      const item = await fx.makeEquipment('RepairCancel');
      const { reservation } = (await reserve(event, { equipmentId: item.id })).body;
      await request(app).patch(`/api/equipment/${item.id}/status`).set(auth(techToken)).send({ status: 'in_repair' });
      const res = await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`).set(auth(techToken)).send({});
      expect(res.body.equipment.status).toBe('in_repair');
    });

    test('cancelling twice is a 409; unknown id a 404', async () => {
      const item = await fx.makeEquipment('Twice');
      const { reservation } = (await reserve(event, { equipmentId: item.id })).body;
      await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`).set(auth(techToken)).send({});
      const again = await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`).set(auth(techToken)).send({});
      expect(again.status).toBe(409);
      const missing = await request(app).post('/api/equipment-reservations/00000000-0000-4000-8000-000000000000/cancel').set(auth(techToken)).send({});
      expect(missing.status).toBe(404);
    });
  });

  describe('permissions', () => {
    test('only Technical Support Staff can reserve or cancel', async () => {
      const item = await fx.makeEquipment('Perm');
      expect((await reserve(event, { equipmentId: item.id }, coordToken)).status).toBe(403);
      expect((await reserve(event, { equipmentId: item.id }, leadToken)).status).toBe(403);
      const { reservation } = (await reserve(event, { equipmentId: item.id })).body;
      const cancel = await request(app).post(`/api/equipment-reservations/${reservation.id}/cancel`).set(auth(coordToken)).send({});
      expect(cancel.status).toBe(403);
    });

    test('unauthenticated requests are rejected', async () => {
      const res = await request(app).post(`/api/events/${event.id}/equipment-reservations`).send({});
      expect(res.status).toBe(401);
    });
  });

  describe('enabling change — Coordinator approval creates the Event', () => {
    test('approving a submitted request creates a planning Event with the request window', async () => {
      const req = await EventRequest.create({
        organiserId: organiser.id,
        eventName: `Approve Me ${fx.suffix}`,
        preferredStart: new Date('2027-08-01T09:00:00Z'),
        preferredEnd: new Date('2027-08-01T11:00:00Z'),
        expectedAttendance: 20,
        status: 'submitted',
        assignedCoordinatorId: coordinator.id,
      });
      const res = await request(app).patch(`/api/event-requests/${req.id}/status`).set(auth(coordToken)).send({ status: 'approved' });
      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({ eventRequestId: req.id, coordinatorId: coordinator.id, status: 'planning' });
      expect(await Event.count({ where: { eventRequestId: req.id } })).toBe(1);
      const item = await fx.makeEquipment('AfterApproval');
      expect((await reserve({ id: res.body.event.id }, { equipmentId: item.id })).status).toBe(201);
    });
  });

  test('rejects reservations for equipment marked in repair without changing its status', async () => {
    const item = await fx.makeEquipment('Repair guard', { status: 'in_repair' });
    const res = await reserve(event, { equipmentId: item.id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EQUIPMENT_NOT_RESERVABLE');
    expect((await Equipment.findByPk(item.id)).status).toBe('in_repair');
  });

  test('rejects a reservation quantity that is not a positive whole number', async () => {
    const item = await fx.makeEquipment('Quantity guard');
    const res = await reserve(event, { equipmentId: item.id, quantity: 0 });
    expect(res.status).toBe(400);
    expect((await Equipment.findByPk(item.id)).status).toBe('available');
  });
});
