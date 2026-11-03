const request = require('supertest');
const app = require('../src/app');
const { sequelize, Role, User, Venue, EventRequest, Event, OperationalSafetyCheck, ROLE_NAMES } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function user(roleName, label) {
  const [role] = await Role.findOrCreate({ where: { name: roleName }, defaults: { name: roleName, displayName: roleName } });
  return User.create({
    email: `safety-${label}-${suffix}@example.com`, passwordHash: await hashPassword(PASSWORD),
    firstName: 'Safety', lastName: label, roleId: role.id,
  });
}
async function login(account) {
  return (await request(app).post('/api/auth/login').send({ email: account.email, password: PASSWORD })).body.accessToken;
}
async function eventFor(organiser, coordinator, venue) {
  const eventRequest = await EventRequest.create({
    organiserId: organiser.id, eventName: 'Safety check event', expectedAttendance: 75,
    requestedLayout: 'Theatre', accessibilityRequirements: 'Wheelchair seating',
    equipmentRequirements: 'Projector and microphones', status: 'approved',
  });
  return Event.create({
    eventRequestId: eventRequest.id, coordinatorId: coordinator.id, venueId: venue.id,
    startDatetime: new Date('2027-06-01T09:00:00Z'), endDatetime: new Date('2027-06-01T12:00:00Z'), status: 'planning',
  });
}

describe('Operational safety check gate', () => {
  let organiser, coordinator, safetyOfficer, otherCoordinator, venue, event, coordinatorToken, safetyToken;
  beforeAll(async () => {
    organiser = await user(ROLE_NAMES.EVENT_ORGANISER, 'organiser');
    coordinator = await user(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator');
    otherCoordinator = await user(ROLE_NAMES.EVENT_COORDINATOR, 'other');
    safetyOfficer = await user(ROLE_NAMES.SAFETY_OFFICER, 'officer');
    venue = await Venue.create({ name: `Safety Hall ${suffix}`, location: 'Campus', capacity: 120 });
    event = await eventFor(organiser, coordinator, venue);
    coordinatorToken = await login(coordinator);
    safetyToken = await login(safetyOfficer);
  });
  afterAll(async () => { await sequelize.close(); });

  const submission = () => ({
    technicalArrangementsConfirmed: true,
    emergencyAccess: 'Keep east driveway clear for emergency vehicles.',
    equipmentPlacement: 'Projector at rear; cables covered.',
    crowdMovement: 'Entry at north doors, exit through south doors.',
    venueRestrictions: 'No open flames.',
  });

  test('requires a coordinator to submit confirmed arrangement information and exposes the safety context', async () => {
    const created = await request(app).post(`/api/events/${event.id}/operational-safety-check`)
      .set(auth(coordinatorToken)).send(submission());
    expect(created.status).toBe(201);
    expect(created.body.operationalSafetyCheck.status).toBe('pending');

    const detail = await request(app).get(`/api/events/${event.id}/operational-safety-check`).set(auth(safetyToken));
    expect(detail.status).toBe(200);
    expect(detail.body.reviewInformation).toMatchObject({ expectedAttendance: 75, venueCapacity: 120, venueLayout: 'Theatre' });
    expect(detail.body.operationalSafetyCheck).toMatchObject({ emergencyAccess: submission().emergencyAccess, crowdMovement: submission().crowdMovement });
  });

  test('preparation cannot be bypassed and request changes returns to arrangements for re-review', async () => {
    const beforeApproval = await request(app).post(`/api/events/${event.id}/proceed-to-preparation`).set(auth(coordinatorToken));
    expect(beforeApproval.status).toBe(409);

    const changes = await request(app).patch(`/api/events/${event.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'request_changes', reason: 'Move the registration desk away from the exit.' });
    expect(changes.status).toBe(200);
    expect(changes.body.event.status).toBe('awaiting_arrangements');

    const resubmitted = await request(app).post(`/api/events/${event.id}/operational-safety-check`)
      .set(auth(coordinatorToken)).send({ ...submission(), crowdMovement: 'North-door entry; a clear south-door emergency exit.' });
    expect(resubmitted.status).toBe(201);
  });

  test('only a Safety Officer may approve, then the coordinator can begin preparation', async () => {
    const unauthorised = await request(app).patch(`/api/events/${event.id}/operational-safety-check/decision`)
      .set(auth(coordinatorToken)).send({ decision: 'approve' });
    expect(unauthorised.status).toBe(403);

    const approved = await request(app).patch(`/api/events/${event.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.operationalSafetyCheck.status).toBe('approved');

    const preparation = await request(app).post(`/api/events/${event.id}/proceed-to-preparation`).set(auth(coordinatorToken));
    expect(preparation.status).toBe(200);
    expect(preparation.body.event.status).toBe('preparation');
  });

  test('a rejected check remains a blocking decision until product policy is clarified', async () => {
    const another = await eventFor(organiser, coordinator, venue);
    await request(app).post(`/api/events/${another.id}/operational-safety-check`).set(auth(coordinatorToken)).send(submission());
    const rejected = await request(app).patch(`/api/events/${another.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'reject', reason: 'Venue not suitable for the planned crowd flow.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.event.status).toBe('awaiting_safety_approval');
    expect((await OperationalSafetyCheck.findOne({ where: { eventId: another.id } })).status).toBe('rejected');
    expect((await request(app).post(`/api/events/${another.id}/proceed-to-preparation`).set(auth(coordinatorToken))).status).toBe(409);
  });
});
