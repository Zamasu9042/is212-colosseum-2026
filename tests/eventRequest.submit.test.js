const request = require('supertest');
const app = require('../src/app');
const { sequelize } = require('../src/models');

const PASSWORD = 'Passw0rd1';

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

describe('Event Request Routes', () => {
  let organiserToken;

  beforeAll(async () => {
    organiserToken = await registerAndLogin(
      `event-organiser-${Date.now()}@example.com`
    );
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('Event Organiser can create an event request as a draft', async () => {
    const res = await request(app)
      .post('/api/event-requests')
      .set('Authorization', `Bearer ${organiserToken}`)
      .send({
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
        registrationRequired: true,
      });

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
      registrationRequired: true,
      status: 'draft',
    });

    expect(res.body.eventRequest.organiserId).toBeDefined();
    expect(res.body.eventRequest.organisationId).toBeDefined();
  });
});

