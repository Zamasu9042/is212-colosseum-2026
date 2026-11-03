process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret-key-for-testing';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing';

const express = require('express');
const request = require('supertest');
const { signAccessToken } = require('../src/utils/jwt');
const notificationRoutes = require('../src/routes/notificationRoutes');

jest.mock('../src/models', () => ({
  User: { findByPk: jest.fn() },
  Role: {},
  Notification: { findAll: jest.fn() },
}));

const { User, Notification } = require('../src/models');

describe('In-app notification preference integration', () => {
  const user = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'attendee@test.com',
    isActive: true,
    organisationId: null,
    Role: { name: 'attendee' },
  };
  const token = signAccessToken({ id: user.id, email: user.email, roleName: user.Role.name });
  const app = express();

  app.use('/api/notifications', notificationRoutes);

  afterEach(() => jest.clearAllMocks());

  test('hides the in-app notification feed when the attendee disables it', async () => {
    User.findByPk.mockResolvedValue({ ...user, communicationPrefs: { inAppNotifications: false } });

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: [], count: 0 });
    expect(Notification.findAll).not.toHaveBeenCalled();
  });

  test('keeps the existing feed available when the setting is enabled or missing', async () => {
    User.findByPk.mockResolvedValue({ ...user, communicationPrefs: {} });
    Notification.findAll.mockResolvedValue([{ id: 'notification-1' }]);

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(Notification.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id },
    }));
  });
});
