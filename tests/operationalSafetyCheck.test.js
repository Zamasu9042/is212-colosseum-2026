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
    eventRequestId: eventRequest.id, coordinatorId: coordinator.id, venueId: venue?.id,
    startDatetime: new Date('2027-06-01T09:00:00Z'), endDatetime: new Date('2027-06-01T12:00:00Z'), status: 'planning',
  });
}

describe('Operational safety check gate', () => {
  let organiser, coordinator, safetyOfficer, otherCoordinator, venue, event, coordinatorToken, safetyToken, otherCoordinatorToken;
  beforeAll(async () => {
    organiser = await user(ROLE_NAMES.EVENT_ORGANISER, 'organiser');
    coordinator = await user(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator');
    otherCoordinator = await user(ROLE_NAMES.EVENT_COORDINATOR, 'other');
    safetyOfficer = await user(ROLE_NAMES.SAFETY_OFFICER, 'officer');
    venue = await Venue.create({ name: `Safety Hall ${suffix}`, location: 'Campus', capacity: 120 });
    event = await eventFor(organiser, coordinator, venue);
    coordinatorToken = await login(coordinator);
    safetyToken = await login(safetyOfficer);
    otherCoordinatorToken = await login(otherCoordinator);
  });
  afterAll(async () => { await sequelize.close(); });

  const submission = () => ({
    technicalArrangementsConfirmed: true,
    emergencyAccess: 'Keep east driveway clear for emergency vehicles.',
    equipmentPlacement: 'Projector at rear; cables covered.',
    crowdMovement: 'Entry at north doors, exit through south doors.',
    venueRestrictions: 'No open flames.',
  });

  async function submitSafetyCheck(targetEvent) {
    const res = await request(app).post(`/api/events/${targetEvent.id}/operational-safety-check`)
      .set(auth(coordinatorToken)).send(submission());
    expect(res.status).toBe(201);
    return res;
  }

  async function approveSafetyCheck(targetEvent) {
    const res = await request(app).patch(`/api/events/${targetEvent.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'approve' });
    expect(res.status).toBe(200);
    return res;
  }

  async function pendingEvent() {
    const targetEvent = await eventFor(organiser, coordinator, venue);
    await submitSafetyCheck(targetEvent);
    return targetEvent;
  }

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

  test('blocks safety review when venue arrangements are unresolved', async () => {
    const unresolved = await eventFor(organiser, coordinator, null);

    const res = await request(app).post(`/api/events/${unresolved.id}/operational-safety-check`)
      .set(auth(coordinatorToken)).send(submission());

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Venue arrangements must be confirmed before an operational safety check.',
      arrangements: { pendingCount: 0, approvedCount: 0 },
    });
    expect(await OperationalSafetyCheck.findOne({ where: { eventId: unresolved.id } })).toBeNull();
    expect((await Event.findByPk(unresolved.id)).status).toBe('planning');
  });

  test('rejects safety-check detail access by an unassigned coordinator', async () => {
    const targetEvent = await pendingEvent();

    const res = await request(app).get(`/api/events/${targetEvent.id}/operational-safety-check`)
      .set(auth(otherCoordinatorToken));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden. You do not have access to this resource.');
  });

  test('rejects safety-check detail request for an unknown event', async () => {
    const res = await request(app).get('/api/events/00000000-0000-4000-8000-000000000000/operational-safety-check')
      .set(auth(safetyToken));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found.');
  });

  test('rejects safety-check detail request when no check exists', async () => {
    const targetEvent = await eventFor(organiser, coordinator, venue);

    const res = await request(app).get(`/api/events/${targetEvent.id}/operational-safety-check`)
      .set(auth(safetyToken));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Operational safety check not found.');
  });

  test('rejects a reject decision without a required reason and preserves state', async () => {
    const targetEvent = await pendingEvent();

    const res = await request(app).patch(`/api/events/${targetEvent.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'reject' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason is required when rejecting or requesting changes.');
    expect((await OperationalSafetyCheck.findOne({ where: { eventId: targetEvent.id } })).status).toBe('pending');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('awaiting_safety_approval');
  });

  test('rejects a request_changes decision without a required reason and preserves state', async () => {
    const targetEvent = await pendingEvent();

    const res = await request(app).patch(`/api/events/${targetEvent.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'request_changes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason is required when rejecting or requesting changes.');
    expect((await OperationalSafetyCheck.findOne({ where: { eventId: targetEvent.id } })).status).toBe('pending');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('awaiting_safety_approval');
  });

  test('rejects a second decision on an already-approved safety check', async () => {
    const targetEvent = await pendingEvent();
    await approveSafetyCheck(targetEvent);

    const res = await request(app).patch(`/api/events/${targetEvent.id}/operational-safety-check/decision`)
      .set(auth(safetyToken)).send({ decision: 'reject', reason: 'Late second decision.' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only a pending safety check can be decided (this one is approved).');
    expect((await OperationalSafetyCheck.findOne({ where: { eventId: targetEvent.id } })).status).toBe('approved');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('confirmed');
  });

  test('rejects repeated transition into preparation', async () => {
    const targetEvent = await pendingEvent();
    await approveSafetyCheck(targetEvent);
    expect((await request(app).post(`/api/events/${targetEvent.id}/proceed-to-preparation`).set(auth(coordinatorToken))).status).toBe(200);

    const res = await request(app).post(`/api/events/${targetEvent.id}/proceed-to-preparation`).set(auth(coordinatorToken));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Event is already in preparation.');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('preparation');
  });

  test('rejects preparation by an unassigned coordinator', async () => {
    const targetEvent = await pendingEvent();
    await approveSafetyCheck(targetEvent);

    const res = await request(app).post(`/api/events/${targetEvent.id}/proceed-to-preparation`).set(auth(otherCoordinatorToken));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden. You do not have access to this resource.');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('confirmed');
  });

  test('rejects preparation for a completed event', async () => {
    const targetEvent = await pendingEvent();
    await approveSafetyCheck(targetEvent);
    await targetEvent.update({ status: 'completed' });

    const res = await request(app).post(`/api/events/${targetEvent.id}/proceed-to-preparation`).set(auth(coordinatorToken));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot begin preparation for a completed event.');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('completed');
  });

  test('rejects preparation for a cancelled event', async () => {
    const targetEvent = await pendingEvent();
    await approveSafetyCheck(targetEvent);
    await targetEvent.update({ status: 'cancelled' });

    const res = await request(app).post(`/api/events/${targetEvent.id}/proceed-to-preparation`).set(auth(coordinatorToken));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot begin preparation for a cancelled event.');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('cancelled');
  });

  test('rejects duplicate safety-review submission while a check is pending', async () => {
    const targetEvent = await pendingEvent();

    const res = await request(app).post(`/api/events/${targetEvent.id}/operational-safety-check`)
      .set(auth(coordinatorToken)).send(submission());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Operational safety check is already pending.');
    expect((await OperationalSafetyCheck.findOne({ where: { eventId: targetEvent.id } })).status).toBe('pending');
    expect((await Event.findByPk(targetEvent.id)).status).toBe('awaiting_safety_approval');
  });
});
