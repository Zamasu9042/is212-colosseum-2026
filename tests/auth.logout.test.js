const request = require('supertest');
const app = require('../src/app');
const { sequelize } = require('../src/models');

describe('Logout', () => {
  afterAll(async () => {
    await sequelize.close();
  });

  test('logout does not require a valid access token (bug fix regression test)', async () => {
    // No Authorization header at all — this previously 401'd before ever
    // reaching the logout handler, meaning a user whose access token had
    // already expired could never log out.
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/logged out/i);
  });

  test('logout works even with a garbage/expired Authorization header', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer this-is-not-a-valid-token');
    expect(res.status).toBe(200);
  });
});
