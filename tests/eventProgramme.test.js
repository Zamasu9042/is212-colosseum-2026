// tests/eventProgramme.test.js
//
// Integration tests for "Event Programme and Agenda". Internal staff
// accounts are provisioned directly (same pattern as
// eventRequest.review.test.js), since public registration blocks
// self-registration for staff roles. Events are created directly via
// the models too, since event creation itself is a separate story.

const request = require('supertest');
const app = require('../src/app');
const { sequelize, Role, User, EventRequest, Event, ROLE_NAMES } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Passw0rd1';

async function ensureRole(name, displayName) {
  const [role] = await Role.findOrCreate({ where: { name }, defaults: { name, displayName } });
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

async function createApprovedEvent(organiser, coordinator, overrides = {}) {
  const eventRequest = await EventRequest.create({
    organiserId: organiser.id,
    organisationId: organiser.organisationId,
    eventName: 'Programme Test Event',
    description: 'Programme test request',
    purpose: 'Testing event programme workflows',
    preferredStart: new Date('2026-11-01T01:00:00.000Z'),
    preferredEnd: new Date('2026-11-01T09:00:00.000Z'),
    expectedAttendance: 80,
    venueRequirements: 'Auditorium seating',
    accessibilityRequirements: 'Wheelchair access',
    equipmentRequirements: 'Projector and microphones',
    layout: 'Theatre seating',
    registrationSetup: 'QR-code registration desk',
    status: 'approved',
    submittedAt: new Date(),
    assignedCoordinatorId: coordinator.id,
  });

  const event = await Event.create({
    eventRequestId: eventRequest.id,
    coordinatorId: coordinator.id,
    startDatetime: new Date('2026-11-01T01:00:00.000Z'),
    endDatetime: new Date('2026-11-01T09:00:00.000Z'),
    status: 'planning',
    ...overrides,
  });

  return { eventRequest, event };
}

describe('Event Programme and Agenda', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let attendee;
  let organiserToken;
  let coordinatorToken;
  let otherCoordinatorToken;
  let attendeeToken;

  beforeAll(async () => {
    organiser = await createUser({
      email: `programme-organiser-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_ORGANISER,
    });
    coordinator = await createUser({
      email: `programme-coordinator-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_COORDINATOR,
    });
    otherCoordinator = await createUser({
      email: `programme-other-coordinator-${suffix}@example.com`,
      roleName: ROLE_NAMES.EVENT_COORDINATOR,
    });
    attendee = await createUser({
      email: `programme-attendee-${suffix}@example.com`,
      roleName: ROLE_NAMES.ATTENDEE,
    });

    organiserToken = await login(organiser.email);
    coordinatorToken = await login(coordinator.email);
    otherCoordinatorToken = await login(otherCoordinator.email);
    attendeeToken = await login(attendee.email);
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('coordinator can create a programme for their event', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);

    const res = await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.programme.status).toBe('draft');
    expect(res.body.programme.eventId).toBe(event.id);
  });

  test('a coordinator not assigned to the event cannot create its programme', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);

    const res = await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${otherCoordinatorToken}`)
      .send();

    expect(res.status).toBe(403);
  });

  test('can add an agenda item with title, description, start/end time and speaker', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const res = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        title: 'Opening Keynote',
        description: 'Welcome address and keynote talk.',
        startTime: '2026-11-01T01:00:00.000Z',
        endTime: '2026-11-01T02:00:00.000Z',
        speaker: 'Dr. Jane Tan',
      });

    expect(res.status).toBe(201);
    expect(res.body.agendaItem).toMatchObject({
      title: 'Opening Keynote',
      description: 'Welcome address and keynote talk.',
      speaker: 'Dr. Jane Tan',
    });
  });

  test('allows creation of a programme containing multiple agenda items', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Session A', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });

    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Session B', startTime: '2026-11-01T02:00:00.000Z', endTime: '2026-11-01T03:00:00.000Z' });

    const res = await request(app)
      .get(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agendaItems).toHaveLength(2);
  });

  test('can edit an agenda item', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const createRes = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Draft Title', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });

    const editRes = await request(app)
      .patch(`/api/events/${event.id}/programme/items/${createRes.body.agendaItem.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Updated Title', speaker: 'New Speaker' });

    expect(editRes.status).toBe(200);
    expect(editRes.body.agendaItem.title).toBe('Updated Title');
    expect(editRes.body.agendaItem.speaker).toBe('New Speaker');
  });

  test('can delete an agenda item', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const createRes = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'To Delete', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });

    const deleteRes = await request(app)
      .delete(`/api/events/${event.id}/programme/items/${createRes.body.agendaItem.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(deleteRes.status).toBe(204);

    const getRes = await request(app)
      .get(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(getRes.body.agendaItems).toHaveLength(0);
  });

  test('can reorder agenda items', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const first = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'First', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });
    const second = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Second', startTime: '2026-11-01T02:00:00.000Z', endTime: '2026-11-01T03:00:00.000Z' });

    const reorderRes = await request(app)
      .patch(`/api/events/${event.id}/programme/items/reorder`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ order: [second.body.agendaItem.id, first.body.agendaItem.id] });

    expect(reorderRes.status).toBe(200);
    expect(reorderRes.body.agendaItems[0].id).toBe(second.body.agendaItem.id);
    expect(reorderRes.body.agendaItems[1].id).toBe(first.body.agendaItem.id);
  });

  test('prevents overlapping agenda item times by default', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Main Session', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T03:00:00.000Z' });

    const overlapRes = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        title: 'Conflicting Session',
        startTime: '2026-11-01T02:00:00.000Z',
        endTime: '2026-11-01T04:00:00.000Z',
      });

    expect(overlapRes.status).toBe(409);
    expect(overlapRes.body.conflictingItemIds).toHaveLength(1);
  });

  test('allows overlapping agenda items when explicitly permitted', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        title: 'Breakout Room A',
        startTime: '2026-11-01T01:00:00.000Z',
        endTime: '2026-11-01T02:00:00.000Z',
        allowOverlap: true,
      });

    const secondRes = await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        title: 'Breakout Room B',
        startTime: '2026-11-01T01:00:00.000Z',
        endTime: '2026-11-01T02:00:00.000Z',
        allowOverlap: true,
      });

    expect(secondRes.status).toBe(201);
  });

  test('can publish a completed programme', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();
    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Keynote', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });

    const publishRes = await request(app)
      .post(`/api/events/${event.id}/programme/publish`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    expect(publishRes.status).toBe(200);
    expect(publishRes.body.programme.status).toBe('published');
    expect(publishRes.body.programme.publishedAt).not.toBeNull();
  });

  test('cannot publish a programme with no agenda items', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const publishRes = await request(app)
      .post(`/api/events/${event.id}/programme/publish`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    expect(publishRes.status).toBe(400);
  });

  test('a draft programme is not visible to an attendee', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const res = await request(app)
      .get(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${attendeeToken}`);

    expect(res.status).toBe(403);
  });

  test('the published programme is visible to anyone, in chronological order', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app)
      .post(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Afternoon Session', startTime: '2026-11-01T05:00:00.000Z', endTime: '2026-11-01T06:00:00.000Z' });
    await request(app)
      .post(`/api/events/${event.id}/programme/items`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Morning Session', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });

    await request(app)
      .post(`/api/events/${event.id}/programme/publish`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send();

    const res = await request(app)
      .get(`/api/events/${event.id}/programme`)
      .set('Authorization', `Bearer ${attendeeToken}`);

    expect(res.status).toBe(200);
    expect(res.body.agendaItems.map((item) => item.title)).toEqual([
      'Morning Session',
      'Afternoon Session',
    ]);
  });

  test('unauthenticated requests are rejected', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    const res = await request(app).post(`/api/events/${event.id}/programme`).send();
    expect(res.status).toBe(401);
  });

  test('rejects creating a second programme for the same event', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This event already has a programme.');
  });

  test('returns not found when creating a programme for an unknown event', async () => {
    const res = await request(app).post('/api/events/00000000-0000-4000-8000-000000000000/programme')
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found.');
  });

  test('allows the owning organiser to view a draft programme', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).get(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${organiserToken}`);
    expect(res.status).toBe(200);
    expect(res.body.programme.status).toBe('draft');
  });

  test('returns not found when viewing an event with no programme', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    const res = await request(app).get(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('This event has no programme yet.');
  });

  test('rejects an agenda item whose end time is not after its start time', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).post(`/api/events/${event.id}/programme/items`).set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Invalid', startTime: '2026-11-01T02:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('endTime must be after startTime.');
  });

  test('rejects an invalid agenda-item reorder without changing items', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const item = await request(app).post(`/api/events/${event.id}/programme/items`).set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Only item', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });
    const res = await request(app).patch(`/api/events/${event.id}/programme/items/reorder`).set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ order: ['00000000-0000-4000-8000-000000000000'] });
    expect(res.status).toBe(400);
    const viewed = await request(app).get(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    expect(viewed.body.agendaItems[0].id).toBe(item.body.agendaItem.id);
  });

  test('rejects editing an agenda item that does not belong to the programme', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).patch(`/api/events/${event.id}/programme/items/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${coordinatorToken}`).send({ title: 'No item' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Agenda item not found.');
  });

  test('rejects editing a published programme without changing its agenda item', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    const item = await request(app).post(`/api/events/${event.id}/programme/items`).set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Locked', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });
    await request(app).post(`/api/events/${event.id}/programme/publish`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).patch(`/api/events/${event.id}/programme/items/${item.body.agendaItem.id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`).send({ title: 'Changed' });
    expect(res.status).toBe(409);
    const viewed = await request(app).get(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    expect(viewed.body.agendaItems[0].title).toBe('Locked');
  });

  test('rejects publishing a programme that is already published', async () => {
    const { event } = await createApprovedEvent(organiser, coordinator);
    await request(app).post(`/api/events/${event.id}/programme`).set('Authorization', `Bearer ${coordinatorToken}`);
    await request(app).post(`/api/events/${event.id}/programme/items`).set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ title: 'Ready', startTime: '2026-11-01T01:00:00.000Z', endTime: '2026-11-01T02:00:00.000Z' });
    await request(app).post(`/api/events/${event.id}/programme/publish`).set('Authorization', `Bearer ${coordinatorToken}`);
    const res = await request(app).post(`/api/events/${event.id}/programme/publish`).set('Authorization', `Bearer ${coordinatorToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This programme is already published.');
  });
});
