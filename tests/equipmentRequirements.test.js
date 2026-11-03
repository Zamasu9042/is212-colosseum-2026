// Record Equipment Requirements for an Event — integration tests.
// (POST/GET/DELETE of request lines are covered by equipment.readiness.test.js;
// this suite covers the story's acceptance criteria end to end plus the new
// edit endpoint and the Technical Support worklist.)
const { sequelize, ROLE_NAMES, EquipmentReservation, Event } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('req');

describe('Record Equipment Requirements for an Event', () => {
  let coordinator, otherCoordinator, organiser, tech;
  let tCoord, tOther, tOrg, tTech;

  const add = (ev, body, token = tCoord) =>
    request(app).post(`/api/events/${ev.id}/equipment-requests`).set(auth(token)).send(body);
  const edit = (ev, id, body, token = tCoord) =>
    request(app).patch(`/api/events/${ev.id}/equipment-requests/${id}`).set(auth(token)).send(body);
  const fresh = (start = '2027-12-01T09:00:00Z', end = '2027-12-01T17:00:00Z') =>
    fx.makeEvent({ organiser, coordinator, start, end });

  beforeAll(async () => {
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
    otherCoordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord2');
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    tech = await fx.createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'tech');
    [tCoord, tOther, tOrg, tTech] = await Promise.all([coordinator, otherCoordinator, organiser, tech].map(fx.login));
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('coordinator records type, quantity and technical requirements against the event; tech staff can view them', async () => {
    const ev = await fresh();
    const res = await add(ev, {
      equipmentType: 'Wireless microphone',
      quantityRequested: 4,
      technicalRequirements: 'Lapel type, 2.4GHz band, spare batteries',
    });
    expect(res.status).toBe(201);
    expect(res.body.equipmentRequest).toMatchObject({
      eventId: ev.id,
      equipmentType: 'Wireless microphone',
      quantityRequested: 4,
      technicalRequirements: 'Lapel type, 2.4GHz band, spare batteries',
    });

    const view = await request(app).get(`/api/events/${ev.id}/equipment-requests`).set(auth(tTech));
    expect(view.status).toBe(200);
    expect(view.body.equipmentRequests.map((r) => r.id)).toContain(res.body.equipmentRequest.id);
  });

  test('missing/invalid quantity or type is rejected; other coordinators and organisers cannot record', async () => {
    const ev = await fresh();
    expect((await add(ev, { equipmentType: 'Projector' })).status).toBe(400);
    expect((await add(ev, { equipmentType: 'Projector', quantityRequested: 0 })).status).toBe(400);
    expect((await add(ev, { quantityRequested: 2 })).status).toBe(400);
    expect((await add(ev, { equipmentType: 'Projector', quantityRequested: 1 }, tOther)).status).toBe(403);
    expect((await add(ev, { equipmentType: 'Projector', quantityRequested: 1 }, tOrg)).status).toBe(403);
  });

  test('Technical Support Staff worklist lists lines across events, filterable and showing allocation', async () => {
    const ev = await fresh('2027-12-02T09:00:00Z', '2027-12-02T12:00:00Z');
    const line = (await add(ev, { equipmentType: 'Laser pointer', quantityRequested: 2 })).body.equipmentRequest;

    const all = await request(app).get('/api/equipment-requests').set(auth(tTech));
    expect(all.status).toBe(200);
    const found = all.body.equipmentRequests.find((r) => r.id === line.id);
    expect(found.Event.EventRequest.eventName).toBeTruthy();
    expect(found.allocation.shortfall).toBe(2);

    const one = await request(app).get('/api/equipment-requests').query({ eventId: ev.id, unallocated: 'true' }).set(auth(tTech));
    expect(one.body.equipmentRequests.map((r) => r.id)).toEqual([line.id]);

    expect((await request(app).get('/api/equipment-requests').set(auth(tCoord))).status).toBe(403);
    expect((await request(app).get('/api/equipment-requests').set(auth(tOrg))).status).toBe(403);
  });

  describe('editing a requirement line', () => {
    test('coordinator can change type, quantity and technical requirements', async () => {
      const ev = await fresh();
      const line = (await add(ev, { equipmentType: 'Projector', quantityRequested: 1 })).body.equipmentRequest;
      const res = await edit(ev, line.id, {
        quantityRequested: 3,
        technicalRequirements: '4K, HDMI + USB-C',
        equipmentType: 'Projector (4K)',
      });
      expect(res.status).toBe(200);
      expect(res.body.equipmentRequest).toMatchObject({
        quantityRequested: 3,
        technicalRequirements: '4K, HDMI + USB-C',
        equipmentType: 'Projector (4K)',
      });
    });

    test('technical support staff may edit; other coordinators and organisers may not', async () => {
      const ev = await fresh();
      const line = (await add(ev, { equipmentType: 'Speaker', quantityRequested: 2 })).body.equipmentRequest;
      expect((await edit(ev, line.id, { quantityRequested: 4 }, tTech)).status).toBe(200);
      expect((await edit(ev, line.id, { quantityRequested: 5 }, tOther)).status).toBe(403);
      expect((await edit(ev, line.id, { quantityRequested: 5 }, tOrg)).status).toBe(403);
    });

    test('validation and not-found cases', async () => {
      const ev = await fresh();
      const line = (await add(ev, { equipmentType: 'Cable', quantityRequested: 2 })).body.equipmentRequest;
      expect((await edit(ev, line.id, {})).status).toBe(400);
      expect((await edit(ev, line.id, { quantityRequested: 0 })).status).toBe(400);
      expect((await edit(ev, '00000000-0000-4000-8000-000000000000', { quantityRequested: 2 })).status).toBe(404);
      const other = await fresh('2027-12-03T09:00:00Z', '2027-12-03T12:00:00Z');
      expect((await edit(other, line.id, { quantityRequested: 2 })).status).toBe(404); // line belongs to another event
    });

    test('quantity cannot drop below what is already reserved', async () => {
      const ev = await fresh();
      const line = (await add(ev, { equipmentType: 'Mixer', quantityRequested: 3 })).body.equipmentRequest;
      const item = await fx.makeEquipment('Mixer', { quantityTotal: 5, quantityAvailable: 5 });
      await EquipmentReservation.create({
        eventId: ev.id,
        equipmentId: item.id,
        equipmentRequestId: line.id,
        quantity: 2,
        startDatetime: ev.startDatetime,
        endDatetime: ev.endDatetime,
        status: 'active',
        reservedBy: tech.id,
      });
      const blocked = await edit(ev, line.id, { quantityRequested: 1 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.reserved).toBe(2);
      expect((await edit(ev, line.id, { quantityRequested: 2 })).status).toBe(200);
    });

    test('editing a need resets technical readiness; closed events are refused', async () => {
      const ev = await fresh();
      const line = (await add(ev, { equipmentType: 'Lights', quantityRequested: 1 })).body.equipmentRequest;
      await ev.update({ technicalReadiness: 'complete' });
      expect((await edit(ev, line.id, { quantityRequested: 2 })).status).toBe(200);
      expect((await Event.findByPk(ev.id)).technicalReadiness).toBe('pending');

      await ev.update({ status: 'cancelled' });
      expect((await edit(ev, line.id, { quantityRequested: 3 })).status).toBe(409);
    });
  });
});