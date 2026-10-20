const request = require('supertest');
const app = require('../src/app');
const {
  sequelize,
  Role,
  User,
  EventRequest,
  Event,
  Venue,
  VenueBooking,
  Equipment,
  Notification,
  ROLE_NAMES,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function createUser(roleName, label, overrides = {}) {
  const [role] = await Role.findOrCreate({
    where: { name: roleName },
    defaults: { name: roleName, displayName: roleName },
  });
  return User.create({
    email: `scrum42-${label}-${suffix}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'SCRUM',
    lastName: label,
    roleId: role.id,
    ...overrides,
  });
}

async function login(user) {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  return res.body.accessToken;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function makeEventRequest(organiser, label, overrides = {}) {
  return EventRequest.create({
    organiserId: organiser.id,
    eventName: `SCRUM-42 ${label} ${suffix}`,
    description: 'Event details needed for role permission tests.',
    purpose: 'Role access verification',
    preferredStart: new Date('2027-04-01T09:00:00Z'),
    preferredEnd: new Date('2027-04-01T12:00:00Z'),
    expectedAttendance: 80,
    venueRequirements: 'Accessible hall',
    accessibilityRequirements: 'Step-free access',
    equipmentRequirements: 'Projector',
    layout: 'Theatre',
    registrationSetup: 'Registration desk',
    status: 'submitted',
    submittedAt: new Date(),
    ...overrides,
  });
}

async function makeEvent(eventRequest, coordinator, status = 'planning') {
  return Event.create({
    eventRequestId: eventRequest.id,
    coordinatorId: coordinator.id,
    startDatetime: new Date('2027-04-01T09:00:00Z'),
    endDatetime: new Date('2027-04-01T12:00:00Z'),
    status,
  });
}

describe('SCRUM-42 — Event Coordinator Lead and Safety Officer roles', () => {
  let organiser;
  let leadA;
  let leadB;
  let coordinatorA;
  let coordinatorB;
  let safetyOfficer;
  let venueStaff;
  let technicalStaff;
  let organiserToken;
  let leadAToken;
  let leadBToken;
  let coordinatorAToken;
  let coordinatorBToken;
  let safetyToken;
  let venueStaffToken;
  let technicalStaffToken;

  beforeAll(async () => {
    [organiser, leadA, leadB, coordinatorA, coordinatorB, safetyOfficer, venueStaff, technicalStaff] =
      await Promise.all([
        createUser(ROLE_NAMES.EVENT_ORGANISER, 'organiser'),
        createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead-a'),
        createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead-b'),
        createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator-a'),
        createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator-b'),
        createUser(ROLE_NAMES.SAFETY_OFFICER, 'safety'),
        createUser(ROLE_NAMES.VENUE_STAFF, 'venue'),
        createUser(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF, 'technical'),
      ]);
    [organiserToken, leadAToken, leadBToken, coordinatorAToken, coordinatorBToken, safetyToken, venueStaffToken, technicalStaffToken] =
      await Promise.all([
        login(organiser), login(leadA), login(leadB), login(coordinatorA), login(coordinatorB),
        login(safetyOfficer), login(venueStaff), login(technicalStaff),
      ]);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('both new roles are recognised as provisioned internal accounts', async () => {
    expect(ROLE_NAMES.EVENT_COORDINATOR_LEAD).toBe('event_coordinator_lead');
    expect(ROLE_NAMES.SAFETY_OFFICER).toBe('safety_officer');
    expect(leadAToken).toBeTruthy();
    expect(safetyToken).toBeTruthy();

    const selfRegistration = await request(app).post('/api/auth/register').send({
      email: `scrum42-self-register-${suffix}@example.com`,
      password: PASSWORD,
      firstName: 'No',
      lastName: 'Access',
      role: ROLE_NAMES.SAFETY_OFFICER,
    });
    expect(selfRegistration.status).toBe(403);
  });

  test('all Leads share the unassigned queue and can assign a Coordinator', async () => {
    const unassigned = await makeEventRequest(organiser, 'unassigned');
    const assigned = await makeEventRequest(organiser, 'already assigned', {
      assignedCoordinatorId: coordinatorA.id,
    });

    const [aQueue, bQueue] = await Promise.all([
      request(app).get('/api/event-requests/unassigned').set(auth(leadAToken)),
      request(app).get('/api/event-requests/unassigned').set(auth(leadBToken)),
    ]);
    expect(aQueue.status).toBe(200);
    expect(bQueue.status).toBe(200);
    expect(aQueue.body.eventRequests.map((item) => item.id)).toContain(unassigned.id);
    expect(bQueue.body.eventRequests.map((item) => item.id)).toContain(unassigned.id);
    expect(aQueue.body.eventRequests.map((item) => item.id)).not.toContain(assigned.id);

    const assignment = await request(app)
      .patch(`/api/event-requests/${unassigned.id}/assignment`)
      .set(auth(leadAToken))
      .send({ coordinatorId: coordinatorA.id });
    expect(assignment.status).toBe(200);
    expect(assignment.body.eventRequest.assignedCoordinatorId).toBe(coordinatorA.id);

    const assignments = await request(app).get('/api/event-requests/assignments').set(auth(leadBToken));
    expect(assignments.status).toBe(200);
    expect(assignments.body.eventRequests.map((item) => item.id)).toEqual(
      expect.arrayContaining([unassigned.id, assigned.id])
    );
  });

  test('a Lead can assign once, the Coordinator is notified, and reassignment is rejected', async () => {
    const eventRequest = await makeEventRequest(organiser, 'initial assignment');

    const assigned = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/assignment`)
      .set(auth(leadBToken))
      .send({ coordinatorId: coordinatorA.id });

    expect(assigned.status).toBe(200);
    expect(assigned.body.eventRequest.assignedCoordinatorId).toBe(coordinatorA.id);
    const notifications = (await Notification.findAll({
      where: { type: 'event_coordinator_assigned' },
    })).filter((notification) => notification.message.includes(eventRequest.eventName));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(coordinatorA.id);
    expect(notifications[0].message).toContain(eventRequest.eventName);

    const secondAttempt = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/assignment`)
      .set(auth(leadBToken))
      .send({ coordinatorId: coordinatorB.id });

    expect(secondAttempt.status).toBe(409);
    expect((await EventRequest.findByPk(eventRequest.id)).assignedCoordinatorId).toBe(coordinatorA.id);
    const notificationsAfterSecondAttempt = (await Notification.findAll({
      where: { type: 'event_coordinator_assigned' },
    })).filter((notification) => notification.message.includes(eventRequest.eventName));
    expect(notificationsAfterSecondAttempt).toHaveLength(1);
  });

  test('concurrent Lead assignments result in one Coordinator and one notification', async () => {
    const eventRequest = await makeEventRequest(organiser, 'concurrent assignment');
    const attempts = await Promise.all([
      request(app)
        .patch(`/api/event-requests/${eventRequest.id}/assignment`)
        .set(auth(leadAToken))
        .send({ coordinatorId: coordinatorA.id }),
      request(app)
        .patch(`/api/event-requests/${eventRequest.id}/assignment`)
        .set(auth(leadBToken))
        .send({ coordinatorId: coordinatorB.id }),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 409]);
    const persisted = await EventRequest.findByPk(eventRequest.id);
    expect([coordinatorA.id, coordinatorB.id]).toContain(persisted.assignedCoordinatorId);
    const notifications = (await Notification.findAll({
      where: { type: 'event_coordinator_assigned' },
    })).filter((notification) => notification.message.includes(eventRequest.eventName));
    expect(notifications).toHaveLength(1);
    expect(notifications.map((notification) => notification.userId)).toContain(persisted.assignedCoordinatorId);
  });

  test('all Leads can view active events, excluding completed and cancelled events', async () => {
    const activeRequest = await makeEventRequest(organiser, 'active event', {
      status: 'approved', assignedCoordinatorId: coordinatorA.id,
    });
    const activeEvent = await makeEvent(activeRequest, coordinatorA, 'planning');
    const completedRequest = await makeEventRequest(organiser, 'completed event', {
      status: 'approved', assignedCoordinatorId: coordinatorA.id,
    });
    const completedEvent = await makeEvent(completedRequest, coordinatorA, 'completed');

    const res = await request(app).get('/api/events/active').set(auth(leadAToken));
    expect(res.status).toBe(200);
    const ids = res.body.events.map((item) => item.id);
    expect(ids).toContain(activeEvent.id);
    expect(ids).not.toContain(completedEvent.id);
  });

  test('only Leads may assign and a target must be an active Event Coordinator', async () => {
    const eventRequest = await makeEventRequest(organiser, 'assignment access');

    const nonLead = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/assignment`)
      .set(auth(safetyToken))
      .send({ coordinatorId: coordinatorA.id });
    expect(nonLead.status).toBe(403);

    const invalidRole = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/assignment`)
      .set(auth(leadAToken))
      .send({ coordinatorId: venueStaff.id });
    expect(invalidRole.status).toBe(422);

    const inactiveCoordinator = await createUser(ROLE_NAMES.EVENT_COORDINATOR, 'inactive', { isActive: false });
    const inactive = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/assignment`)
      .set(auth(leadAToken))
      .send({ coordinatorId: inactiveCoordinator.id });
    expect(inactive.status).toBe(422);
    const notifications = (await Notification.findAll({
      where: { type: 'event_coordinator_assigned' },
    })).filter((notification) => notification.message.includes(eventRequest.eventName));
    expect(notifications).toHaveLength(0);
  });

  test('Coordinators can review only requests assigned to them', async () => {
    const own = await makeEventRequest(organiser, 'coordinator own', { assignedCoordinatorId: coordinatorA.id });
    const other = await makeEventRequest(organiser, 'coordinator other', { assignedCoordinatorId: coordinatorB.id });

    const queue = await request(app).get('/api/event-requests/review-queue').set(auth(coordinatorAToken));
    expect(queue.status).toBe(200);
    expect(queue.body.eventRequests.map((item) => item.id)).toContain(own.id);
    expect(queue.body.eventRequests.map((item) => item.id)).not.toContain(other.id);

    const otherRead = await request(app)
      .get(`/api/event-requests/${other.id}`)
      .set(auth(coordinatorAToken));
    expect(otherRead.status).toBe(403);

    const otherDecision = await request(app)
      .patch(`/api/event-requests/${other.id}/status`)
      .set(auth(coordinatorAToken))
      .send({ status: 'approved' });
    expect(otherDecision.status).toBe(403);
  });

  test('Safety Officers have read-only safety context and no mutation permissions', async () => {
    const eventRequest = await makeEventRequest(organiser, 'safety context', {
      status: 'approved', assignedCoordinatorId: coordinatorA.id,
    });
    const event = await makeEvent(eventRequest, coordinatorA);
    const venue = await Venue.create({
      name: `SCRUM-42 Hall ${suffix}`,
      location: 'Campus',
      capacity: 150,
      venueType: 'Hall',
      status: 'available',
    });
    await VenueBooking.create({
      eventId: event.id,
      venueId: venue.id,
      requestedBy: coordinatorA.id,
      startDatetime: event.startDatetime,
      endDatetime: event.endDatetime,
      expectedAttendance: 80,
      status: 'pending',
    });
    await Equipment.create({
      name: `SCRUM-42 Projector ${suffix}`,
      type: 'AV',
      quantityTotal: 2,
      quantityAvailable: 2,
      status: 'available',
    });

    const [requestRead, eventRead, bookingRead, equipmentRead] = await Promise.all([
      request(app).get(`/api/event-requests/${eventRequest.id}`).set(auth(safetyToken)),
      request(app).get(`/api/events/${event.id}`).set(auth(safetyToken)),
      request(app).get(`/api/events/${event.id}/venue-bookings`).set(auth(safetyToken)),
      request(app).get('/api/equipment').set(auth(safetyToken)),
    ]);
    expect(requestRead.status).toBe(200);
    expect(eventRead.status).toBe(200);
    expect(bookingRead.status).toBe(200);
    expect(equipmentRead.status).toBe(200);

    const [assignment, decision, equipmentWrite, bookingWrite] = await Promise.all([
      request(app).patch(`/api/event-requests/${eventRequest.id}/assignment`).set(auth(safetyToken))
        .send({ coordinatorId: coordinatorA.id }),
      request(app).patch(`/api/event-requests/${eventRequest.id}/status`).set(auth(safetyToken))
        .send({ status: 'approved' }),
      request(app).post('/api/equipment').set(auth(safetyToken)).send({}),
      request(app).post(`/api/events/${event.id}/venue-bookings`).set(auth(safetyToken)).send({}),
    ]);
    expect(assignment.status).toBe(403);
    expect(decision.status).toBe(403);
    expect(equipmentWrite.status).toBe(403);
    expect(bookingWrite.status).toBe(403);
  });
});
