// Regression tests for equipment/approval bugs found in the October review.
//  BUG-3  An item stayed "reserved" forever after its last reservation ended.
//  BUG-4  Equipment could be reserved for a time window that had already ended.
//  BUG-5  Reservations on items later put in repair/unavailable still counted
//         towards technical readiness, and readiness stayed "complete".
//  BUG-6  Lowering an item's units in service below what is already reserved
//         silently over-committed it.
//  BUG-7  A request accepted by Venue Staff never became an Event, so it could
//         not be planned (no venue/equipment arrangements possible).
const {
  sequelize, ROLE_NAMES, Equipment, EquipmentReservation, Event, EventRequest, Notification,
} = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('buge');

describe('Equipment bug fixes', () => {
  let tech, coordinator, organiser, staff, techToken, staffToken;
  const reserve = (ev, body) => request(app).post(`/api/events/${ev.id}/equipment-reservations`).set(auth(techToken)).send(body);

  beforeAll(async () => {
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    staff = await fx.createUser(ROLE_NAMES.VENUE_STAFF, 'staff');
    [techToken, staffToken] = await Promise.all([tech, staff].map(fx.login));
  });
  afterAll(async () => { await sequelize.close(); });

  test('BUG-3 an item whose only reservation has ended reads as available again', async () => {
    const item = await fx.makeEquipment('Ended', { status: 'reserved' });
    const past = await fx.makeEvent({ organiser, coordinator, status: 'completed', start: '2025-01-01T09:00:00Z', end: '2025-01-01T10:00:00Z' });
    await EquipmentReservation.create({ eventId: past.id, equipmentId: item.id, quantity: 1, startDatetime: past.startDatetime, endDatetime: past.endDatetime, status: 'active', reservedBy: tech.id });
    const detail = await request(app).get(`/api/equipment/${item.id}`).set(auth(techToken));
    expect(detail.body.equipment.status).toBe('available');
    const list = await request(app).get(`/api/equipment?status=reserved&search=${encodeURIComponent(item.name)}`).set(auth(techToken));
    expect(list.body.equipment).toHaveLength(0);
  });

  test('BUG-4 reserving for a window that has already ended is refused', async () => {
    const item = await fx.makeEquipment('PastWindow');
    const ev = await fx.makeEvent({ organiser, coordinator, start: '2025-03-01T09:00:00Z', end: '2025-03-01T10:00:00Z' });
    const res = await reserve(ev, { equipmentId: item.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/already ended/);
  });

  describe('BUG-5 out-of-service items do not count towards readiness', () => {
    let event, item, line;
    beforeAll(async () => {
      event = await fx.makeEvent({ organiser, coordinator, start: '2028-03-01T09:00:00Z', end: '2028-03-01T12:00:00Z' });
      item = await fx.makeEquipment('Breaks Later', { type: 'Projector' });
      line = (await request(app).post(`/api/events/${event.id}/equipment-requests`).set(auth(techToken)).send({ equipmentType: 'Projector', quantityRequested: 1 })).body.equipmentRequest;
      await reserve(event, { equipmentId: item.id, equipmentRequestId: line.id });
      expect((await request(app).patch(`/api/events/${event.id}/technical-readiness`).set(auth(techToken)).send({ complete: true })).status).toBe(200);
    });

    test('putting the item in repair reverts readiness and notifies the coordinator', async () => {
      const res = await request(app).patch(`/api/equipment/${item.id}/status`).set(auth(techToken)).send({ status: 'in_repair' });
      expect(res.status).toBe(200);
      expect(res.body.readinessRevertedEventIds).toEqual([event.id]);
      expect((await Event.findByPk(event.id)).technicalReadiness).toBe('pending');
      const note = await Notification.findOne({ where: { userId: coordinator.id, eventId: event.id, type: 'equipment_out_of_service' } });
      expect(note).not.toBeNull();
    });

    test('allocation no longer counts the broken item, so readiness is blocked', async () => {
      const status = await request(app).get(`/api/events/${event.id}/technical-readiness`).set(auth(techToken));
      expect(status.body.canComplete).toBe(false);
      expect(status.body.allocation.lines[0]).toMatchObject({ quantityAllocated: 0, outOfServiceQuantity: 1 });
      expect((await request(app).patch(`/api/events/${event.id}/technical-readiness`).set(auth(techToken)).send({ complete: true })).status).toBe(409);
    });

    test('a replacement item can be allocated to the line, then readiness completes', async () => {
      const spare = await fx.makeEquipment('Spare', { type: 'Projector' });
      expect((await reserve(event, { equipmentId: spare.id, equipmentRequestId: line.id })).status).toBe(201);
      expect((await request(app).patch(`/api/events/${event.id}/technical-readiness`).set(auth(techToken)).send({ complete: true })).status).toBe(200);
    });
  });

  test('BUG-6 units in service cannot drop below what is reserved at one time', async () => {
    const item = await fx.makeEquipment('Chairs', { type: 'Furniture', quantityTotal: 10, quantityAvailable: 10 });
    const ev = await fx.makeEvent({ organiser, coordinator, start: '2028-04-01T09:00:00Z', end: '2028-04-01T12:00:00Z' });
    await reserve(ev, { equipmentId: item.id, quantity: 6 });
    const tooLow = await request(app).patch(`/api/equipment/${item.id}`).set(auth(techToken)).send({ quantityAvailable: 5 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error).toMatch(/6 unit/);
    expect((await Equipment.findByPk(item.id)).quantityAvailable).toBe(10);
    expect((await request(app).patch(`/api/equipment/${item.id}`).set(auth(techToken)).send({ quantityAvailable: 6 })).status).toBe(200);
  });

  test('BUG-7 a request accepted by Venue Staff becomes a planning Event', async () => {
    const req = await EventRequest.create({
      organiserId: organiser.id, eventName: `Accepted ${fx.suffix}`, preferredStart: new Date('2028-05-01T09:00:00Z'),
      preferredEnd: new Date('2028-05-01T11:00:00Z'), expectedAttendance: 30, requestedLayout: 'theatre',
      accessibilityRequirements: 'none', facilityRequirements: 'wifi', setupRequirements: 'none', status: 'submitted',
    });
    const res = await request(app).patch(`/api/event-requests/${req.id}/status`).set(auth(staffToken)).send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ eventRequestId: req.id, status: 'planning' });
  });
});
