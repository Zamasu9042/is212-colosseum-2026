const request = require('supertest');
const { Op } = require('sequelize');
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
  let organiserUserId;
  let coordinator;

  beforeAll(async () => {
    organiserToken = await registerAndLogin(
      `event-organiser-${suffix}@example.com`
    );
    const organiser = await User.findOne({ where: { email: `event-organiser-${suffix}@example.com` } });
    organiserUserId = organiser.id;
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
    expect(submitRes.body.eventRequest.assignedCoordinatorId).toBeTruthy();
    expect(submitRes.body.eventRequest.submittedAt).toBeTruthy();
    expect(submitRes.body.eventRequest.assignedCoordinator).toBeTruthy();
    expect(submitRes.body.eventRequest.assignedCoordinator.id).toBe(
      submitRes.body.eventRequest.assignedCoordinatorId
    );
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

  test('submission fails without an active Event Coordinator and leaves the draft unchanged', async () => {
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

      expect(submitRes.status).toBe(409);
      expect(submitRes.body.error).toMatch(/No active Event Coordinator/);

      const persisted = await EventRequest.findByPk(createRes.body.eventRequest.id);
      expect(persisted.status).toBe('draft');
      expect(persisted.submittedAt).toBeNull();
      expect(persisted.assignedCoordinatorId).toBeNull();
    } finally {
      await Promise.all(
        previousStates.map((user) =>
          User.update({ isActive: user.isActive }, { where: { id: user.id } })
        )
      );
    }
  });

  test('submission assigns the coordinator with the fewest pending-review requests', async () => {
    const role = await ensureRole(ROLE_NAMES.EVENT_COORDINATOR, 'Event Coordinator');
    const existingCoordinators = await User.findAll({ where: { roleId: role.id } });
    const previousStates = existingCoordinators.map((user) => ({
      id: user.id,
      isActive: user.isActive,
    }));
    const busyCoordinator = await createCoordinator(`busy-coordinator-${suffix}@example.com`);
    const availableCoordinator = await createCoordinator(`available-coordinator-${suffix}@example.com`);

    await User.update(
      { isActive: false },
      {
        where: {
          roleId: role.id,
          id: { [Op.notIn]: [busyCoordinator.id, availableCoordinator.id] },
        },
      }
    );

    try {
      await EventRequest.create({
        organiserId: organiserUserId,
        eventName: 'Existing pending request',
        description: 'Already pending',
        purpose: 'Load balancing fixture',
        preferredStart: new Date('2026-11-12T09:00:00Z'),
        preferredEnd: new Date('2026-11-12T10:00:00Z'),
        expectedAttendance: 40,
        venueRequirements: 'Seminar room',
        accessibilityRequirements: 'Lift access',
        equipmentRequirements: 'Microphone',
        layout: 'Classroom',
        registrationSetup: 'Name list at entrance',
        status: 'submitted',
        submittedAt: new Date(),
        assignedCoordinatorId: busyCoordinator.id,
      });

      await EventRequest.create({
        organiserId: organiserUserId,
        eventName: 'Second pending request',
        description: 'Already under review',
        purpose: 'Load balancing fixture',
        preferredStart: new Date('2026-11-13T09:00:00Z'),
        preferredEnd: new Date('2026-11-13T10:00:00Z'),
        expectedAttendance: 40,
        venueRequirements: 'Seminar room',
        accessibilityRequirements: 'Lift access',
        equipmentRequirements: 'Microphone',
        layout: 'Classroom',
        registrationSetup: 'Name list at entrance',
        status: 'under_review',
        submittedAt: new Date(),
        assignedCoordinatorId: busyCoordinator.id,
      });

      const createRes = await request(app)
        .post('/api/event-requests')
        .set('Authorization', `Bearer ${organiserToken}`)
        .send(completeRequestPayload);

      const submitRes = await request(app)
        .post(`/api/event-requests/${createRes.body.eventRequest.id}/submit`)
        .set('Authorization', `Bearer ${organiserToken}`);

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.eventRequest.assignedCoordinatorId).toBe(availableCoordinator.id);
    } finally {
      await Promise.all(
        previousStates.map((user) =>
          User.update({ isActive: user.isActive }, { where: { id: user.id } })
        )
      );
    }
  });
});
