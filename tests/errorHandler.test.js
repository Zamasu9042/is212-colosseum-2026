const request = require('supertest');
const app = require('../src/app');
const { sequelize, Role, User } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

describe('Error handler: client-caused Postgres constraint violations', () => {
  let venueStaffToken;

  beforeAll(async () => {
    const role = await Role.findOne({ where: { name: 'venue_staff' } });
    const passwordHash = await hashPassword('Passw0rd1');
    await User.findOrCreate({
      where: { email: 'errorhandler-venue-staff@example.com' },
      defaults: {
        email: 'errorhandler-venue-staff@example.com',
        passwordHash,
        firstName: 'Err',
        lastName: 'Handler',
        roleId: role.id,
      },
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'errorhandler-venue-staff@example.com', password: 'Passw0rd1' });
    venueStaffToken = res.body.accessToken;
  });

  afterAll(async () => {
    await sequelize.close();
  });

  test('an invalid enum value (bypassing app-level validation) returns 400, not 500', async () => {
    const res = await request(app)
      .post('/api/venues')
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ name: 'Bad Status Venue', location: 'Nowhere', capacity: 10, status: 'not_a_real_status' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('a genuinely missing required field still returns 400 via normal Sequelize validation', async () => {
    const res = await request(app)
      .post('/api/venues')
      .set('Authorization', `Bearer ${venueStaffToken}`)
      .send({ name: 'No Capacity Venue', location: 'Nowhere' });

    expect(res.status).toBe(400);
  });
});
