const attendeeController = require('../controllers/attendeeController');
const { User, Role } = require('../../src/models');

// Mock User and Role
jest.mock('../../src/models', () => {
  return {
    User: {
      findByPk: jest.fn(),
    },
    Role: {},
  };
});

function mockResponse() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Attendee Controller', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getProfile', () => {
    test('returns 404 if attendee is not found or inactive', async () => {
      User.findByPk.mockResolvedValue(null);
      const req = { user: { id: 'attendee-123', role: 'attendee' } };
      const res = mockResponse();
      const next = jest.fn();

      await attendeeController.getProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/not found/i) })
      );
    });

    test('returns only attendee-facing profile fields', async () => {
      const mockUser = {
        id: 'attendee-123',
        email: 'attendee@example.com',
        firstName: 'John',
        lastName: 'Doe',
        phone: '+6591234567',
        isActive: true,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        Role: { name: 'attendee' },
      };
      User.findByPk.mockResolvedValue(mockUser);

      const req = { user: { id: 'attendee-123', role: 'attendee' } };
      const res = mockResponse();
      const next = jest.fn();

      await attendeeController.getProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        attendee: expect.objectContaining({
          id: 'attendee-123',
          email: 'attendee@example.com',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+6591234567',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }),
      });
    });
  });

  describe('updateProfile', () => {
    test('updates contact details and organization and returns the updated attendee', async () => {
      const mockUser = {
        id: 'attendee-123',
        email: 'attendee@example.com',
        firstName: 'Old',
        lastName: 'Name',
        phone: '+6588888888',
        organization: 'Old Organisation',
        isActive: true,
        Role: { name: 'attendee' },
        update: jest.fn().mockImplementation(function (fields) {
          Object.assign(this, fields);
          return Promise.resolve(this);
        }),
      };
      User.findByPk.mockResolvedValue(mockUser);

      const req = {
        user: { id: 'attendee-123', role: 'attendee' },
        body: {
          firstName: 'Jane',
          lastName: 'Smith',
          phone: '+6599999999',
          organization: 'ConnectSphere Club',
          email: 'jane@example.com',
        },
      };
      const res = mockResponse();
      const next = jest.fn();

      await attendeeController.updateProfile(req, res, next);

      expect(mockUser.update).toHaveBeenCalledWith({
        firstName: 'Jane',
        lastName: 'Smith',
        phone: '+6599999999',
        organization: 'ConnectSphere Club',
        email: 'jane@example.com',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Profile updated successfully.',
          attendee: expect.objectContaining({
            firstName: 'Jane',
            lastName: 'Smith',
            phone: '+6599999999',
            organization: 'ConnectSphere Club',
            email: 'jane@example.com',
          }),
        })
      );
    });
  });

});
