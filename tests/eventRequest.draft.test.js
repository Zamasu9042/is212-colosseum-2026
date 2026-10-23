// tests/eventRequest.draft.test.js
//
// Integration tests against the real app + a test Postgres database.

const request = require('supertest');
const app = require('../src/app');
const { sequelize, EventRequest } = require('../src/models');

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({
    email,
    password: 'Passw0rd1',
    firstName: 'Jane',
    lastName: 'Tan',
    role: 'event_organiser',
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Passw0rd1' });

  return res.body.accessToken;
}

describe('Save Event Request as Draft', () => {
  let organiserAToken;
  let organiserBToken;

  beforeAll(async () => {
    organiserAToken = await registerAndLogin('organiser-a@example.com');
    organiserBToken = await registerAndLogin('organiser-b@example.com');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('can save an incomplete event request as a draft without submitting it', async () => {
    const res = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Freshman Orientation' }); // everything else left blank

    expect(res.status).toBe(201);
    expect(res.body.eventRequest.status).toBe('draft');
    expect(res.body.eventRequest.submittedAt).toBeNull();
    expect(res.body.eventRequest.eventName).toBe('Freshman Orientation');
  });

  test('draft is associated with the correct Event Organiser, and is not visible to others', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Ownership check' });

    const draftId = createRes.body.eventRequest.id;
    expect(createRes.body.eventRequest.organiserId).toBeDefined();

    const otherRes = await request(app)
      .get(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserBToken}`);

    expect(otherRes.status).toBe(403);
  });

  test('organiser can access their own saved draft after leaving and returning', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Alumni Dinner' });

    const draftId = createRes.body.eventRequest.id;

    // Simulate "returning to the system" — a fresh request, same token.
    const listRes = await request(app)
      .get('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.eventRequests.some((d) => d.id === draftId)).toBe(true);
  });

  test('reopening a draft shows the previously saved information', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({
        eventName: 'Career Fair',
        expectedAttendance: 250,
        venueRequirements: 'Main Hall, wheelchair accessible',
      });

    const draftId = createRes.body.eventRequest.id;

    const getRes = await request(app)
      .get(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserAToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.eventRequest).toMatchObject({
      eventName: 'Career Fair',
      expectedAttendance: 250,
      venueRequirements: 'Main Hall, wheelchair accessible',
    });
  });

  test('organiser can edit previously saved information and save the draft again', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Draft to edit', expectedAttendance: 10 });

    const draftId = createRes.body.eventRequest.id;

    const updateRes = await request(app)
      .patch(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Draft to edit (updated)', expectedAttendance: 40 });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.eventRequest.eventName).toBe('Draft to edit (updated)');
    expect(updateRes.body.eventRequest.expectedAttendance).toBe(40);

    // Persisted — fetch again to confirm the second save stuck.
    const getRes = await request(app)
      .get(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserAToken}`);

    expect(getRes.body.eventRequest.eventName).toBe('Draft to edit (updated)');
  });

  test('saving the draft does not submit it, change its status, or set submittedAt', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Should stay a draft' });

    const draftId = createRes.body.eventRequest.id;

    const updateRes = await request(app)
      .patch(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ description: 'Still just a draft' });

    expect(updateRes.body.eventRequest.status).toBe('draft');
    expect(updateRes.body.eventRequest.submittedAt).toBeNull();
  });

  test('an organiser cannot edit another organiser\'s draft', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Private draft' });

    const res = await request(app)
      .patch(`/api/event-requests/${createRes.body.eventRequest.id}`)
      .set('Authorization', `Bearer ${organiserBToken}`)
      .send({ eventName: 'Attempted takeover' });

    expect(res.status).toBe(403);
  });

  test('a submitted request cannot be edited through the draft-save endpoint', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Locked after submission' });
    const draft = await EventRequest.findByPk(createRes.body.eventRequest.id);
    await draft.update({ status: 'submitted', submittedAt: new Date() });

    const res = await request(app)
      .patch(`/api/event-requests/${draft.id}`)
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'This must not be saved' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/draft status/i);
  });

  test('cannot smuggle status/organiserId changes through create or edit', async () => {
    const createRes = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ eventName: 'Smuggle attempt', status: 'approved', organiserId: 'not-me' });

    expect(createRes.body.eventRequest.status).toBe('draft');
    expect(createRes.body.eventRequest.organiserId).not.toBe('not-me');

    const draftId = createRes.body.eventRequest.id;
    const updateRes = await request(app)
      .patch(`/api/event-requests/${draftId}`)
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ status: 'submitted' });

    expect(updateRes.body.eventRequest.status).toBe('draft');
  });

  test('rejects malformed fields without saving anything', async () => {
    const res = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserAToken}`)
      .send({ expectedAttendance: 'a lot' }); // not an integer

    expect(res.status).toBe(400);
  });

  test('unauthenticated requests are rejected', async () => {
    const res = await request(app).post('/api/event-requests').send({});
    expect(res.status).toBe(401);
  });
});
