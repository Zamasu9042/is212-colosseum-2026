const request = require('supertest');
const app = require('../src/app');
const { sequelize, EventRequest, Role, User, ROLE_NAMES } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';

async function ensureRole(name, displayName) {
  const [role] = await Role.findOrCreate({
    where: { name },
    defaults: { name, displayName },
  });
  return role;
}

async function createCoordinator(email, overrides = {}) {
  const role = await ensureRole(ROLE_NAMES.EVENT_COORDINATOR, 'Event Coordinator');

  return User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Casey',
    lastName: 'Coordinator',
    roleId: role.id,
    ...overrides,
  });
}

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({
    email,
    password: PASSWORD,
    firstName: 'Test',
    lastName: 'User',
    role: 'event_organiser',
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({
      email,
      password: PASSWORD,
    });

  return res.body.accessToken;
}

const completeRequestPayload = {
  eventName: 'Technology Conference',
  description: 'Annual technology conference',
  purpose: 'Networking and knowledge sharing',
  category: 'Conference',
  preferredStart: '2026-11-10T09:00:00Z',
  preferredEnd: '2026-11-10T17:00:00Z',
  expectedAttendance: 100,
  venueRequirements: 'Large hall',
  accessibilityRequirements: 'Wheelchair accessible',
  equipmentRequirements: 'Projector and microphones',
  layout: 'Theatre seating with registration desk near the entrance',
  registrationSetup: 'Online registration with QR-code check-in',
  registrationRequired: true,
};

describe('Event Request Routes', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let organiserToken;
  let coordinator;

  beforeAll(async () => {
    organiserToken = await registerAndLogin(
      `event-organiser-${suffix}@example.com`
    );
    const organiser = await User.findOne({ where: { email: `event-organiser-${suffix}@example.com` } });
    coordinator = await createCoordinator(`submit-coordinator-${suffix}@example.com`);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('Event Organiser can create an event request as a draft', async () => {
    const res = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send(completeRequestPayload);

    expect(res.status).toBe(201);

    expect(res.body.eventRequest).toMatchObject({
      eventName: 'Technology Conference',
      description: 'Annual technology conference',
      purpose: 'Networking and knowledge sharing',
      category: 'Conference',
      expectedAttendance: 100,
      venueRequirements: 'Large hall',
      accessibilityRequirements: 'Wheelchair accessible',
      equipmentRequirements: 'Projector and microphones',
      layout: 'Theatre seating with registration desk near the entrance',
      registrationSetup: 'Online registration with QR-code check-in',
      registrationRequired: true,
      status: 'draft',
    });

    expect(res.body.eventRequest.organiserId).toBeDefined();
    expect(res.body.eventRequest.organisationId).toBeDefined();
    expect(res.body.eventRequest.assignedCoordinatorId).toBeNull();
  });

  test('Event Organiser can submit a complete request for pending review', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send(completeRequestPayload);

    const submitRes = await request(app)
      .post(`/api/event-requests/${createRes.body.eventRequest.id}/submit`)
      .set('Authorization', `Bearer ${organiserToken}`);

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.eventRequest).toMatchObject({
      id: createRes.body.eventRequest.id,
      status: 'submitted',
    });
    expect(submitRes.body.eventRequest.assignedCoordinatorId).toBeNull();
    expect(submitRes.body.eventRequest.submittedAt).toBeTruthy();
    expect(submitRes.body.eventRequest.assignedCoordinator).toBeNull();
  });

  test('submission rejects missing mandatory fields and keeps the request as a draft', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send({
        eventName: 'Incomplete conference',
        preferredStart: '2026-11-10T09:00:00Z',
        preferredEnd: '2026-11-10T17:00:00Z',
        expectedAttendance: 100,
      });

    const submitRes = await request(app)
      .post(`/api/event-requests/${createRes.body.eventRequest.id}/submit`)
      .set('Authorization', `Bearer ${organiserToken}`);

    expect(submitRes.status).toBe(400);
    expect(submitRes.body.missingFields).toEqual(
      expect.arrayContaining([
        'description',
        'purpose',
        'venueRequirements',
        'accessibilityRequirements',
        'equipmentRequirements',
        'layout',
        'registrationSetup',
      ])
    );

    const persisted = await EventRequest.findByPk(createRes.body.eventRequest.id);
    expect(persisted.status).toBe('draft');
    expect(persisted.assignedCoordinatorId).toBeNull();
  });

  test('drafts can save and edit new fields without assigning a coordinator', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send({ layout: 'Initial classroom layout' });

    const updateRes = await request(app)
      .patch(`/api/event-requests/${createRes.body.eventRequest.id}`)
      .set('Authorization', `Bearer ${organiserToken}`)
      .send({
        layout: 'Banquet rounds',
        registrationSetup: 'Manual registration table',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.eventRequest).toMatchObject({
      layout: 'Banquet rounds',
      registrationSetup: 'Manual registration table',
      status: 'draft',
      assignedCoordinatorId: null,
    });
  });

  test('submission remains available and unassigned when no Coordinator is active', async () => {
    const role = await ensureRole(ROLE_NAMES.EVENT_COORDINATOR, 'Event Coordinator');
    const existingCoordinators = await User.findAll({ where: { roleId: role.id } });
    const previousStates = existingCoordinators.map((user) => ({
      id: user.id,
      isActive: user.isActive,
    }));

    await User.update({ isActive: false }, { where: { roleId: role.id } });

    try {
      const createRes = await request(app)
        .post('/api/event-requests')
        .set('Authorization', `Bearer ${organiserToken}`)
        .send(completeRequestPayload);

      const submitRes = await request(app)
        .post(`/api/event-requests/${createRes.body.eventRequest.id}/submit`)
        .set('Authorization', `Bearer ${organiserToken}`);

      expect(submitRes.status).toBe(200);

      const persisted = await EventRequest.findByPk(createRes.body.eventRequest.id);
      expect(persisted.status).toBe('submitted');
      expect(persisted.submittedAt).toBeTruthy();
      expect(persisted.assignedCoordinatorId).toBeNull();
    } finally {
      await Promise.all(
        previousStates.map((user) =>
          User.update({ isActive: user.isActive }, { where: { id: user.id } })
        )
      );
    }
  });

  test('submission stays unassigned even when active Coordinators exist', async () => {
    expect(coordinator.isActive).toBe(true);
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send(completeRequestPayload);

    const submitRes = await request(app)
      .post(`/api/event-requests/${createRes.body.eventRequest.id}/submit`)
      .set('Authorization', `Bearer ${organiserToken}`);

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.eventRequest.assignedCoordinatorId).toBeNull();
  });

  test.each([0, -1])('rejects invalid expected attendance value %i without creating a draft', async (expectedAttendance) => {
    const countBefore = await EventRequest.count();

    const res = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send({ ...completeRequestPayload, expectedAttendance });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed.');
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'expectedAttendance' }),
    ]));
    expect(await EventRequest.count()).toBe(countBefore);
  });
});
