// tests/eventRequest.review.test.js
//
// Integration tests for SCRUM 13: Event Review and Approval.
// Internal staff accounts are provisioned directly because public
// registration deliberately blocks self-registration for staff roles.

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Role, User, EventRequest, ROLE_NAMES } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';

async function ensureRole(name, displayName) {
  const [role] = await Role.findOrCreate({
    where: { name },
    defaults: { name, displayName },
  });
  return role;
}

async function createUser({ email, roleName, firstName = 'Test', lastName = 'User' }) {
  const role = await ensureRole(
    roleName,
    roleName
      .split('_')
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ')
  );

  return User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName,
    lastName,
    roleId: role.id,
  });
}

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.accessToken;
}

async function createSubmittedRequest(organiser, overrides = {}) {
  return EventRequest.create({
    organiserId: organiser.id,
    organisationId: organiser.organisationId,
    eventName: 'Student Leadership Forum',
    description: 'A forum for student leaders to share plans and feedback.',
    purpose: 'Community engagement',
    category: 'forum',
    preferredStart: new Date('2026-11-01T02:00:00.000Z'),
    preferredEnd: new Date('2026-11-01T05:00:00.000Z'),
    expectedAttendance: 120,
    venueRequirements: 'Auditorium seating',
    requestedLayout: 'Theatre',
    accessibilityRequirements: 'Wheelchair access',
    facilityRequirements: 'Wi-Fi and accessible restrooms',
    setupRequirements: 'Set up theatre seating and lectern 30 minutes before the event.',
    equipmentRequirements: 'Projector and two microphones',
    layout: 'Theatre seating with aisle access',
    registrationSetup: 'Online registration with check-in desk',
    registrationRequired: true,
    status: 'submitted',
    submittedAt: new Date(),
    ...overrides,
  });
}

describe('Event Review and Approval', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let organiserA;
  let organiserB;
  let coordinator;
  let venueStaff;
  let attendee;
  let organiserAToken;
  let organiserBToken;
  let coordinatorToken;
  let venueStaffToken;
  let attendeeToken;

  beforeAll(async () => {
    organiserA = await createUser({
      email: `review-organiser-a-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_ORGANISER,
      firstName: 'Jane',
      lastName: 'Tan',
    });
    organiserB = await createUser({
      email: `review-organiser-b-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_ORGANISER,
      firstName: 'Alex',
      lastName: 'Lim',
    });
    coordinator = await createUser({
      email: `review-coordinator-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_COORDINATOR,
      firstName: 'Casey',
      lastName: 'Ng',
    });
    venueStaff = await createUser({
      email: `review-venue-staff-${suffix}@example.com`,
      roleName: ROLE_NAMES.VENUE_STAFF,
      firstName: 'Jordan',
      lastName: 'Koh',
    });
    attendee = await createUser({
      email: `review-attendee-${suffix}@example.com`,
      roleName: ROLE_NAMES.ATTENDEE,
      firstName: 'Sam',
      lastName: 'Lee',
    });

    organiserAToken = await login(organiserA.email);
    organiserBToken = await login(organiserB.email);
    coordinatorToken = await login(coordinator.email);
    venueStaffToken = await login(venueStaff.email);
    attendeeToken = await login(attendee.email);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('coordinator can list submitted and under review requests awaiting review', async () => {
    const submitted = await createSubmittedRequest(organiserA, {
      eventName: 'Submitted review queue item',
      assignedCoordinatorId: coordinator.id,
    });
    const underReview = await createSubmittedRequest(organiserA, {
      eventName: 'Under review queue item',
      status: 'under_review',
      assignedCoordinatorId: coordinator.id,
    });
    const draft = await createSubmittedRequest(organiserA, {
      eventName: 'Draft should not appear',
      status: 'draft',
      submittedAt: null,
    });

    const res = await request(app)
      .get('/api/event-requests/review-queue')
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.eventRequests.map((eventRequest) => eventRequest.id);
    expect(ids).toContain(submitted.id);
    expect(ids).toContain(underReview.id);
    expect(ids).not.toContain(draft.id);

    const queued = res.body.eventRequests.find((eventRequest) => eventRequest.id === submitted.id);
    expect(queued.organiser).toMatchObject({
      id: organiserA.id,
      email: organiserA.email,
      firstName: 'Jane',
      lastName: 'Tan',
    });
    expect(queued.organiser.passwordHash).toBeUndefined();
  });

  test('venue staff can search pending booking requests and view final decision history', async () => {
    const pending = await createSubmittedRequest(organiserA, {
      eventName: 'Harbour ballroom booking',
    });
    const nonMatchingPending = await createSubmittedRequest(organiserB, {
      eventName: 'Campus workshop booking',
    });
    const approved = await createSubmittedRequest(organiserA, {
      eventName: 'Harbour booking approved',
      status: 'approved',
      reviewedAt: new Date(),
      reviewedBy: coordinator.id,
    });
    const rejected = await createSubmittedRequest(organiserA, {
      eventName: 'Harbour booking rejected',
      status: 'rejected',
      reviewReason: 'Venue is unavailable.',
      reviewedAt: new Date(),
      reviewedBy: coordinator.id,
    });

    const pendingRes = await request(app)
      .get('/api/event-requests/booking-requests/pending?search=harbour')
      .set('Authorization', `Bearer ${venueStaffToken}`);

    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.eventRequests.map((item) => item.id)).toContain(pending.id);
    expect(pendingRes.body.eventRequests.map((item) => item.id)).not.toContain(nonMatchingPending.id);
    expect(pendingRes.body.eventRequests.every((item) => ['submitted', 'under_review'].includes(item.status))).toBe(true);

    const historyRes = await request(app)
      .get('/api/event-requests/booking-requests/history?search=harbour')
      .set('Authorization', `Bearer ${venueStaffToken}`);

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.eventRequests.map((item) => item.id)).toEqual(
      expect.arrayContaining([approved.id, rejected.id])
    );
    expect(historyRes.body.eventRequests.every((item) => ['approved', 'rejected'].includes(item.status))).toBe(true);
  });

  test('venue staff can approve or reject a pending booking request', async () => {
    const approvalCandidate = await createSubmittedRequest(organiserA, {
      eventName: 'Venue staff approval candidate',
    });
    const rejectionCandidate = await createSubmittedRequest(organiserA, {
      eventName: 'Venue staff rejection candidate',
    });

    const approvalRes = await request(app)
      .patch(`/api/event-requests/${approvalCandidate.id}/status`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ status: 'approved' });
    expect(approvalRes.status).toBe(200);
    expect(approvalRes.body.eventRequest.reviewedBy).toBe(venueStaff.id);

    const rejectionRes = await request(app)
      .patch(`/api/event-requests/${rejectionCandidate.id}/status`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ status: 'rejected', reviewReason: 'Requested room is under maintenance.' });
    expect(rejectionRes.status).toBe(200);
    expect(rejectionRes.body.eventRequest.reviewedBy).toBe(venueStaff.id);

    const returnedRes = await request(app)
      .patch(`/api/event-requests/${rejectionCandidate.id}/status`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ status: 'returned', reviewReason: 'Please clarify.' });
    expect(returnedRes.status).toBe(400);
  });

  test('venue staff see decision details and missing-detail flags for a booking request', async () => {
    const complete = await createSubmittedRequest(organiserA, {
      eventName: 'Complete booking detail view',
    });
    const incomplete = await createSubmittedRequest(organiserA, {
      eventName: 'Incomplete booking detail view',
      requestedLayout: '   ',
      accessibilityRequirements: null,
      facilityRequirements: null,
      setupRequirements: null,
    });

    const detailRes = await request(app)
      .get(`/api/event-requests/booking-requests/${complete.id}`)
      .set('Authorization', `Bearer ${venueStaffToken}`);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.eventRequest.bookingDetails).toMatchObject({
      expectedAttendance: 120,
      requestedLayout: 'Theatre',
      accessibilityNeeds: 'Wheelchair access',
      facilityRequirements: 'Wi-Fi and accessible restrooms',
      setupRequirements: 'Set up theatre seating and lectern 30 minutes before the event.',
    });
    expect(detailRes.body.eventRequest.bookingDetails.startDateTime).toBeTruthy();
    expect(detailRes.body.eventRequest.bookingDetails.endDateTime).toBeTruthy();
    expect(detailRes.body.eventRequest.isReadyForApproval).toBe(true);
    expect(detailRes.body.eventRequest.missingDetails).toEqual([]);

    const pendingRes = await request(app)
      .get('/api/event-requests/booking-requests/pending?search=Incomplete%20booking%20detail')
      .set('Authorization', `Bearer ${venueStaffToken}`);
    const queuedIncomplete = pendingRes.body.eventRequests.find((item) => item.id === incomplete.id);
    expect(queuedIncomplete.isReadyForApproval).toBe(false);
    expect(queuedIncomplete.missingDetails).toEqual(
      expect.arrayContaining(['requested layout', 'accessibility needs', 'facility requirements', 'setup requirements'])
    );
  });

  test('venue staff cannot approve a booking request with mandatory details missing', async () => {
    const incomplete = await createSubmittedRequest(organiserA, {
      eventName: null,
      preferredStart: null,
      expectedAttendance: null,
      requestedLayout: null,
      accessibilityRequirements: null,
      facilityRequirements: null,
      setupRequirements: null,
    });

    const res = await request(app)
      .patch(`/api/event-requests/${incomplete.id}/status`)
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/incomplete/i);
    expect(res.body.missingDetails).toEqual(
      expect.arrayContaining([
        'event name',
        'start date and time',
        'expected attendance',
        'requested layout',
        'accessibility needs',
        'facility requirements',
        'setup requirements',
      ])
    );
  });

  test('coordinator can fetch a submitted request and see its review details', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Detailed coordinator review',
      assignedCoordinatorId: coordinator.id,
    });

    const res = await request(app)
      .get(`/api/event-requests/${eventRequest.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.eventRequest).toMatchObject({
      id: eventRequest.id,
      eventName: 'Detailed coordinator review',
      description: 'A forum for student leaders to share plans and feedback.',
      purpose: 'Community engagement',
      expectedAttendance: 120,
      venueRequirements: 'Auditorium seating',
      requestedLayout: 'Theatre',
      accessibilityRequirements: 'Wheelchair access',
      facilityRequirements: 'Wi-Fi and accessible restrooms',
      setupRequirements: 'Set up theatre seating and lectern 30 minutes before the event.',
      equipmentRequirements: 'Projector and two microphones',
      registrationRequired: true,
      status: 'submitted',
      organiserId: organiserA.id,
    });
    expect(res.body.eventRequest.organiser.email).toBe(organiserA.email);
  });

  test('coordinator can approve a submitted request', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Approval candidate',
      assignedCoordinatorId: coordinator.id,
    });

    const res = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.eventRequest.status).toBe('approved');
    expect(res.body.eventRequest.reviewedBy).toBe(coordinator.id);
    expect(res.body.eventRequest.reviewedAt).toBeTruthy();
  });

  test('coordinator can return a request with a clarification reason', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Clarification candidate',
      assignedCoordinatorId: coordinator.id,
    });

    const res = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        status: 'returned',
        reviewReason: 'Please clarify the expected AV setup.',
      });

    expect(res.status).toBe(200);
    expect(res.body.eventRequest.status).toBe('returned');
    expect(res.body.eventRequest.reviewReason).toBe('Please clarify the expected AV setup.');
  });

  test('coordinator cannot reject without a written reason', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Incomplete rejection',
      assignedCoordinatorId: coordinator.id,
    });

    const res = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ status: 'rejected', reviewReason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewReason is required/);
  });

  test('coordinator can reject with a written reason', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Rejection candidate',
      assignedCoordinatorId: coordinator.id,
    });

    const res = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        status: 'rejected',
        reviewReason: 'The proposed timing conflicts with campus operating constraints.',
      });

    expect(res.status).toBe(200);
    expect(res.body.eventRequest.status).toBe('rejected');
    expect(res.body.eventRequest.reviewReason).toBe(
      'The proposed timing conflicts with campus operating constraints.'
    );
    expect(res.body.eventRequest.reviewedBy).toBe(coordinator.id);
  });

  test('updated review outcome is visible to the owning organiser', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Visible outcome candidate',
      assignedCoordinatorId: coordinator.id,
    });

    await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        status: 'returned',
        reviewReason: 'Please provide the final registration plan.',
      });

    const organiserRes = await request(app)
      .get(`/api/event-requests/${eventRequest.id}`)
      .set('Authorization', `Bearer ${organiserAToken}`);

    expect(organiserRes.status).toBe(200);
    expect(organiserRes.body.eventRequest.status).toBe('returned');
    expect(organiserRes.body.eventRequest.reviewReason).toBe(
      'Please provide the final registration plan.'
    );
  });

  test("a different organiser cannot view someone else's request", async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'Private organiser request',
    });

    const res = await request(app)
      .get(`/api/event-requests/${eventRequest.id}`)
      .set('Authorization', `Bearer ${organiserBToken}`);

    expect(res.status).toBe(403);
  });

  test('non-coordinators and unauthenticated users cannot perform review actions', async () => {
    const eventRequest = await createSubmittedRequest(organiserA, {
      eventName: 'RBAC review candidate',
    });

    const organiserRes = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ status: 'approved' });
    expect(organiserRes.status).toBe(403);

    const attendeeRes = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .set('Authorization', `Bearer ${attendeeToken}`)
      .send({ status: 'approved' });
    expect(attendeeRes.status).toBe(403);

    const unauthenticatedRes = await request(app)
      .patch(`/api/event-requests/${eventRequest.id}/status`)
      .send({ status: 'approved' });
    expect(unauthenticatedRes.status).toBe(401);
  });
});
