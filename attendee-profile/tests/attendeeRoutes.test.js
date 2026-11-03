process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret-key-for-testing';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing';

const express = require('express');
const request = require('supertest');
const { signAccessToken } = require('../../src/utils/jwt');
const { ROLE_NAMES } = require('../../src/models/Role');
const { User } = require('../../src/models');
const { attendeeRoutes } = require('../index');
const { errorHandler } = require('../../src/middleware/errorHandler');

jest.mock('../../src/models', () => {
  return {
    User: {
      findByPk: jest.fn(),
    },
    Role: {},
  };
});

describe('Attendee Routes & RBAC Integration', () => {
  let app;
  let attendeeToken;
  let organiserToken;
  let venueStaffToken;

  const mockAttendee = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'attendee@test.com',
    firstName: 'Alex',
    lastName: 'Tan',
    phone: '+6591234567',
    communicationPrefs: { preferredLanguage: 'en' },
    roleId: 5,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    Role: { name: ROLE_NAMES.ATTENDEE },
    update: jest.fn().mockImplementation(function (fields) {
      Object.assign(this, fields);
      return Promise.resolve(this);
    }),
  };

  const mockOrganiser = {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'organiser@test.com',
    firstName: 'Boss',
    lastName: 'Lee',
    roleId: 1,
    isActive: true,
    Role: { name: ROLE_NAMES.EVENT_ORGANISER },
  };

  const mockVenueStaff = {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'staff@test.com',
    firstName: 'Staff',
    lastName: 'Wong',
    roleId: 3,
    isActive: true,
    Role: { name: ROLE_NAMES.VENUE_STAFF },
  };

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret-key-for-testing';
    process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing';

    app = express();
    app.use(express.json());
    app.use('/api/attendees', attendeeRoutes);
    app.use(errorHandler);

    attendeeToken = signAccessToken({
      id: mockAttendee.id,
      email: mockAttendee.email,
      roleName: ROLE_NAMES.ATTENDEE,
    });
    organiserToken = signAccessToken({
      id: mockOrganiser.id,
      email: mockOrganiser.email,
      roleName: ROLE_NAMES.EVENT_ORGANISER,
    });
    venueStaffToken = signAccessToken({
      id: mockVenueStaff.id,
      email: mockVenueStaff.email,
      roleName: ROLE_NAMES.VENUE_STAFF,
    });
  });

  beforeEach(() => {
    User.findByPk.mockImplementation((id) => {
      if (id === mockAttendee.id) return Promise.resolve(mockAttendee);
      if (id === mockOrganiser.id) return Promise.resolve(mockOrganiser);
      if (id === mockVenueStaff.id) return Promise.resolve(mockVenueStaff);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication & RBAC boundaries', () => {
    test('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/attendees/profile');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authentication required/i);
    });

    test('rejects event organisers with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendees/profile')
        .set('Authorization', `Bearer ${organiserToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/forbidden/i);
    });

    test('rejects venue staff with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/attendees/profile')
        .set('Authorization', `Bearer ${venueStaffToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/forbidden/i);
    });

    test('permits authenticated attendee to access their profile', async () => {
      const res = await request(app)
        .get('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.attendee.email).toBe('attendee@test.com');
      expect(res.body.attendee.role).toBeUndefined();
    });
  });

  describe('Profile Maintenance (GET & PATCH /profile)', () => {
    test('successfully updates attendee contact details and organization', async () => {
      const res = await request(app)
        .patch('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({
          firstName: 'Alexander',
          lastName: 'Tan Updated',
          phone: '+6581234567',
          organization: 'ConnectSphere Society',
          email: 'alexander@test.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/profile updated successfully/i);
      expect(mockAttendee.update).toHaveBeenCalledWith({
        firstName: 'Alexander',
        lastName: 'Tan Updated',
        phone: '+6581234567',
        organization: 'ConnectSphere Society',
        email: 'alexander@test.com',
      });
    });

    test('allows a valid email address update', async () => {
      const res = await request(app)
        .patch('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({
          email: 'updated@test.com',
        });

      expect(res.status).toBe(200);
      expect(mockAttendee.update).toHaveBeenCalledWith({ email: 'updated@test.com' });
    });

    test('rejects attempt to alter immutable field: role', async () => {
      const res = await request(app)
        .patch('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({
          role: 'event_coordinator',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed.');
      expect(
        res.body.details.some((d) => /immutable fields cannot be updated/i.test(d.msg))
      ).toBe(true);
    });

    test('rejects empty payload when updating profile', async () => {
      const res = await request(app)
        .patch('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed.');
      expect(
        res.body.details.some((d) => /at least one profile field/i.test(d.msg))
      ).toBe(true);
    });

    test('rejects empty string for firstName', async () => {
      const res = await request(app)
        .patch('/api/attendees/profile')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({ firstName: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed.');
      expect(
        res.body.details.some((d) => /first name cannot be empty/i.test(d.msg))
      ).toBe(true);
    });
  });

  test('PATCH /profile rejects an invalid email address', async () => {
    const res = await request(app)
      .patch('/api/attendees/profile')
      .set('Authorization', `Bearer ${attendeeToken}`)
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed.');
    expect(res.body.details.some((d) => /email must be a valid/i.test(d.msg))).toBe(true);
  });

  describe('Notification preferences', () => {
    beforeEach(() => {
      mockAttendee.communicationPrefs = { preferredLanguage: 'en' };
    });

    test('returns defaults when no toggles have been saved', async () => {
      const res = await request(app)
        .get('/api/attendees/preferences')
        .set('Authorization', `Bearer ${attendeeToken}`);

      expect(res.status).toBe(200);
      expect(res.body.notificationPreferences).toEqual({
        emailNotifications: true,
        inAppNotifications: true,
      });
    });

    test('updates toggles and retains unrelated stored preferences', async () => {
      const res = await request(app)
        .patch('/api/attendees/preferences')
        .set('Authorization', `Bearer ${attendeeToken}`)
        .send({ emailNotifications: false, inAppNotifications: false });

      expect(res.status).toBe(200);
      expect(res.body.notificationPreferences).toEqual({
        emailNotifications: false,
        inAppNotifications: false,
      });
      expect(mockAttendee.update).toHaveBeenCalledWith({
        communicationPrefs: {
          preferredLanguage: 'en',
          emailNotifications: false,
          inAppNotifications: false,
        },
      });
    });

    test('rejects empty, unsupported, and non-boolean preference updates', async () => {
      for (const body of [{}, { emailNotifications: 'yes' }, { department: 'Finance' }]) {
        const res = await request(app)
          .patch('/api/attendees/preferences')
          .set('Authorization', `Bearer ${attendeeToken}`)
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed.');
      }
    });

    test('blocks non-attendee roles from notification preferences', async () => {
      const res = await request(app)
        .get('/api/attendees/preferences')
        .set('Authorization', `Bearer ${organiserToken}`);

      expect(res.status).toBe(403);
    });
  });
});
