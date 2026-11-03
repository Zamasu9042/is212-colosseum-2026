// Organiser amends a submitted (not yet approved) event request.
const request = require('supertest');
const app = require('../src/app');
const { sequelize, EventRequest, Notification, Role, User } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const payload = {
  eventName: 'Amend Conference', description: 'Desc', purpose: 'Purpose', category: 'conference',
  preferredStart: '2027-03-10T09:00:00Z', preferredEnd: '2027-03-10T17:00:00Z', expectedAttendance: 100,
  venueRequirements: 'Large hall', accessibilityRequirements: 'Step free', equipmentRequirements: 'Projector',
  layout: 'Theatre', registrationSetup: 'Online', registrationRequired: true,
};

async function organiser(email) {
  await request(app).post('/api/auth/register').send({ email, password: PASSWORD, firstName: 'T', lastName: 'U', role: 'event_organiser' });
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.accessToken;
}

describe('PATCH /api/event-requests/:id/amend', () => {
  let token, otherToken, coordinator, er;

  beforeAll(async () => {
    token = await organiser(`amend-org-${suffix}@example.com`);
    otherToken = await organiser(`amend-org2-${suffix}@example.com`);
    const [role] = await Role.findOrCreate({ where: { name: 'event_coordinator' }, defaults: { name: 'event_coordinator', displayName: 'Event Coordinator' } });
    coordinator = await User.create({ email: `amend-coord-${suffix}@example.com`, passwordHash: await hashPassword(PASSWORD), firstName: 'C', lastName: 'C', roleId: role.id });
    const created = await request(app).post('/api/event-requests').set('Authorization', `Bearer ${token}`).send(payload);
    er = created.body.eventRequest;
    await request(app).post(`/api/event-requests/${er.id}/submit`).set('Authorization', `Bearer ${token}`);
    await EventRequest.update({ assignedCoordinatorId: coordinator.id }, { where: { id: er.id } });
  });

  afterAll(async () => { await sequelize.close(); });

  const amend = (id, body, t = token) => request(app).patch(`/api/event-requests/${id}/amend`).set('Authorization', `Bearer ${t}`).send(body);

  test('organiser can change a submitted request and the coordinator is notified', async () => {
    const res = await amend(er.id, { expectedAttendance: 150, venueRequirements: 'Bigger hall' });
    expect(res.status).toBe(200);
    expect(res.body.changedFields.sort()).toEqual(['expectedAttendance', 'venueRequirements']);
    expect((await EventRequest.findByPk(er.id)).expectedAttendance).toBe(150);
    expect(await Notification.count({ where: { userId: coordinator.id, type: 'event_request_amended' } })).toBe(1);
  });

  test('another organiser cannot amend it', async () => {
    expect((await amend(er.id, { expectedAttendance: 5 }, otherToken)).status).toBe(403);
  });

  test('required information cannot be blanked', async () => {
    const res = await amend(er.id, { eventName: '' });
    expect(res.status).toBe(400);
  });

  test('end must be after start', async () => {
    expect((await amend(er.id, { preferredEnd: '2027-03-10T08:00:00Z' })).status).toBe(400);
  });

  test('approved or draft requests cannot use this route', async () => {
    await EventRequest.update({ status: 'approved' }, { where: { id: er.id } });
    expect((await amend(er.id, { expectedAttendance: 99 })).status).toBe(409);
  });
});