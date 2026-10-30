// SCRUM-22: Manage Equipment Catalogue Status — integration tests.
// Needs a database with schema.sql applied (npm run db:init && npm run db:seed).
const { sequelize, ROLE_NAMES, Equipment } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('s22');

describe('SCRUM-22 Manage Equipment Catalogue Status', () => {
  let tech, coordinator, organiser, safety, techToken, coordToken, safetyToken;
  let working, repairing, retired, booked, event;

  beforeAll(async () => {
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    safety = await fx.createUser(ROLE_NAMES.SAFETY_OFFICER, 'safety');
    [techToken, coordToken, safetyToken] = await Promise.all([tech, coordinator, safety].map(fx.login));

    working = await fx.makeEquipment('Working', { type: `S22TYPE-${fx.suffix}` });
    repairing = await fx.makeEquipment('Repairing', { type: `S22TYPE-${fx.suffix}`, status: 'in_repair' });
    retired = await fx.makeEquipment('Retired', { type: `S22TYPE-${fx.suffix}`, status: 'unavailable' });
    booked = await fx.makeEquipment('Booked', { type: `S22TYPE-${fx.suffix}` });
    event = await fx.makeEvent({
      organiser, coordinator, start: '2027-06-01T09:00:00Z', end: '2027-06-01T12:00:00Z',
    });
    const other = await fx.makeEvent({
      organiser, coordinator, start: '2027-06-01T10:00:00Z', end: '2027-06-01T11:00:00Z',
    });
    const r = await request(app).post(`/api/events/${other.id}/equipment-reservations`)
      .set(auth(techToken)).send({ equipmentId: booked.id });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  const typeFilter = () => `type=S22TYPE-${fx.suffix}`;

  describe('AC1 — in-repair / unavailable items are removed from selectable reservation lists', () => {
    test('selectable=true drops in_repair and unavailable items', async () => {
      const res = await request(app).get(`/api/equipment?selectable=true&${typeFilter()}`).set(auth(techToken));
      expect(res.status).toBe(200);
      const ids = res.body.equipment.map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([working.id, booked.id]));
      expect(ids).not.toContain(repairing.id);
      expect(ids).not.toContain(retired.id);
    });

    test('with an event window, items fully booked in that window are also dropped', async () => {
      const res = await request(app)
        .get(`/api/equipment?selectable=true&eventId=${event.id}&${typeFilter()}`).set(auth(techToken));
      expect(res.status).toBe(200);
      const ids = res.body.equipment.map((e) => e.id);
      expect(ids).toEqual([working.id]);
      expect(res.body.equipment[0].availableQuantity).toBe(1);
    });

    test('a different window brings the booked item back', async () => {
      const res = await request(app)
        .get(`/api/equipment?selectable=true&startDatetime=2027-06-01T11:00:00Z&endDatetime=2027-06-01T12:00:00Z&${typeFilter()}`)
        .set(auth(techToken));
      expect(res.body.equipment.map((e) => e.id).sort()).toEqual([working.id, booked.id].sort());
    });

    test('startDatetime without endDatetime is rejected', async () => {
      const res = await request(app).get('/api/equipment?startDatetime=2027-06-01T11:00:00Z').set(auth(techToken));
      expect(res.status).toBe(400);
    });

    test('unknown eventId is a 404', async () => {
      const res = await request(app)
        .get('/api/equipment?selectable=true&eventId=00000000-0000-4000-8000-000000000000').set(auth(techToken));
      expect(res.status).toBe(404);
    });
  });

  describe('AC2 — reservations on in-repair / unavailable items are blocked with an error', () => {
    test.each([
      ['in_repair', () => repairing, /in repair/],
      ['unavailable', () => retired, /unavailable/],
    ])('%s item: 422 with explanation, nothing created', async (_status, getItem, pattern) => {
      const res = await request(app).post(`/api/events/${event.id}/equipment-reservations`)
        .set(auth(techToken)).send({ equipmentId: getItem().id });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('EQUIPMENT_NOT_RESERVABLE');
      expect(res.body.error).toMatch(pattern);
      const detail = await request(app).get(`/api/equipment/${getItem().id}`).set(auth(techToken));
      expect(detail.body.reservations).toHaveLength(0);
    });

    test('an item put in repair becomes unreservable immediately', async () => {
      const item = await fx.makeEquipment('Breaks');
      const patch = await request(app).patch(`/api/equipment/${item.id}/status`)
        .set(auth(techToken)).send({ status: 'in_repair' });
      expect(patch.status).toBe(200);
      expect(patch.body.equipment.status).toBe('in_repair');
      const res = await request(app).post(`/api/events/${event.id}/equipment-reservations`)
        .set(auth(techToken)).send({ equipmentId: item.id });
      expect(res.status).toBe(422);
    });

    test('putting a reserved item in repair keeps reservations but warns', async () => {
      const item = await fx.makeEquipment('ReservedThenBroken');
      await request(app).post(`/api/events/${event.id}/equipment-reservations`)
        .set(auth(techToken)).send({ equipmentId: item.id });
      const patch = await request(app).patch(`/api/equipment/${item.id}/status`)
        .set(auth(techToken)).send({ status: 'in_repair' });
      expect(patch.body.equipment.status).toBe('in_repair');
      expect(patch.body.affectedReservations).toHaveLength(1);
      expect(patch.body.warning).toMatch(/1 upcoming reservation/);

      // Back to service: status is re-derived from the live reservation.
      const back = await request(app).patch(`/api/equipment/${item.id}/status`)
        .set(auth(techToken)).send({ status: 'available' });
      expect(back.body.equipment.status).toBe('reserved');
    });
  });

  describe('AC3 — catalogue can be filtered by status', () => {
    test('status=available shows available items only', async () => {
      const res = await request(app).get(`/api/equipment?status=available&${typeFilter()}`).set(auth(techToken));
      expect(res.status).toBe(200);
      expect(res.body.equipment.map((e) => e.id)).toEqual([working.id]);
      expect(res.body.equipment.every((e) => e.status === 'available')).toBe(true);
    });

    test('comma-separated statuses', async () => {
      const res = await request(app).get(`/api/equipment?status=in_repair,unavailable&${typeFilter()}`).set(auth(techToken));
      expect(res.body.equipment.map((e) => e.id).sort()).toEqual([repairing.id, retired.id].sort());
    });

    test('status=reserved shows items with live reservations', async () => {
      const res = await request(app).get(`/api/equipment?status=reserved&${typeFilter()}`).set(auth(techToken));
      expect(res.body.equipment.map((e) => e.id)).toEqual([booked.id]);
      expect(res.body.equipment[0].statusLabel).toBe('Reserved');
    });

    test('no filter returns every status; empty results carry a message', async () => {
      const all = await request(app).get(`/api/equipment?${typeFilter()}`).set(auth(techToken));
      expect(all.body.count).toBe(4);
      const none = await request(app).get('/api/equipment?type=NO-SUCH-TYPE').set(auth(techToken));
      expect(none.body.equipment).toEqual([]);
      expect(none.body.message).toMatch(/No equipment/);
    });

    test('invalid status filter is a 400', async () => {
      const res = await request(app).get('/api/equipment?status=broken').set(auth(techToken));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown status filter/);
    });

    test('Coordinators and Safety Officers can filter too (read-only)', async () => {
      for (const token of [coordToken, safetyToken]) {
        const res = await request(app).get(`/api/equipment?status=available&${typeFilter()}`).set(auth(token));
        expect(res.status).toBe(200);
      }
    });
  });

  describe('status updates — permissions and validation', () => {
    test("'reserved' cannot be set by hand", async () => {
      const res = await request(app).patch(`/api/equipment/${working.id}/status`)
        .set(auth(techToken)).send({ status: 'reserved' });
      expect(res.status).toBe(400);
      const viaGeneric = await request(app).patch(`/api/equipment/${working.id}`)
        .set(auth(techToken)).send({ status: 'reserved' });
      expect(viaGeneric.status).toBe(400);
    });

    test('unknown status is rejected', async () => {
      const res = await request(app).patch(`/api/equipment/${working.id}/status`)
        .set(auth(techToken)).send({ status: 'lost' });
      expect(res.status).toBe(400);
    });

    test('only Technical Support Staff can change status', async () => {
      const res = await request(app).patch(`/api/equipment/${working.id}/status`)
        .set(auth(coordToken)).send({ status: 'in_repair' });
      expect(res.status).toBe(403);
      expect((await Equipment.findByPk(working.id)).status).toBe('available');
    });

    test('unknown equipment is a 404', async () => {
      const res = await request(app).patch('/api/equipment/00000000-0000-4000-8000-000000000000/status')
        .set(auth(techToken)).send({ status: 'in_repair' });
      expect(res.status).toBe(404);
    });

    test('generic PATCH edits fields and can set a manual status', async () => {
      const item = await fx.makeEquipment('Edit');
      const res = await request(app).patch(`/api/equipment/${item.id}`)
        .set(auth(techToken)).send({ location: 'Store B', status: 'unavailable' });
      expect(res.status).toBe(200);
      expect(res.body.equipment).toMatchObject({ location: 'Store B', status: 'unavailable' });
    });

    test('POST creates with quantityAvailable defaulted to quantityTotal', async () => {
      const res = await request(app).post('/api/equipment').set(auth(techToken))
        .send({ name: `S22 New ${fx.suffix}`, type: 'AV', quantityTotal: 3 });
      expect(res.status).toBe(201);
      expect(res.body.equipment).toMatchObject({ quantityAvailable: 3, status: 'available' });
      const bad = await request(app).post('/api/equipment').set(auth(techToken))
        .send({ name: 'x', type: 'AV', quantityTotal: 1, status: 'reserved' });
      expect(bad.status).toBe(400);
    });
  });
});
