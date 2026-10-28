// Shared fixtures for the equipment integration suites (SCRUM-21/22/24).
// Everything gets a unique per-run suffix so suites can be re-run safely.
const request = require('supertest');
const app = require('../../src/app');
const { Role, User, Equipment, Event, EventRequest, Venue } = require('../../src/models');
const { hashPassword } = require('../../src/utils/password');

const PASSWORD = 'Passw0rd1';

function makeFixtures(prefix) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  async function createUser(roleName, label, extra = {}) {
    const [role] = await Role.findOrCreate({
      where: { name: roleName },
      defaults: { name: roleName, displayName: roleName },
    });
    return User.create({
      email: `${prefix}-${label}-${suffix}@example.com`.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      firstName: extra.firstName || 'Test',
      lastName: extra.lastName || label,
      roleId: role.id,
    });
  }

  async function login(user) {
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    return res.body.accessToken;
  }

  async function makeEquipment(label, overrides = {}) {
    return Equipment.create({
      name: `${prefix} ${label} ${suffix}`,
      type: 'AV',
      quantityTotal: 1,
      quantityAvailable: 1,
      location: 'Store A',
      status: 'available',
      ...overrides,
    });
  }

  async function makeVenue(label, overrides = {}) {
    return Venue.create({
      name: `${prefix} ${label} ${suffix}`,
      location: overrides.location || 'Campus North',
      capacity: 200,
      venueType: 'Hall',
      status: 'available',
      setupMinutes: 60,
      teardownMinutes: 60,
      ...overrides,
    });
  }

  async function makeEvent({ organiser, coordinator, start, end, status = 'planning', name, venue }) {
    const eventRequest = await EventRequest.create({
      organiserId: organiser.id,
      eventName: name || `${prefix} Event ${suffix}`,
      preferredStart: new Date(start),
      preferredEnd: new Date(end),
      expectedAttendance: 50,
      status: 'approved',
      assignedCoordinatorId: coordinator.id,
    });
    return Event.create({
      eventRequestId: eventRequest.id,
      coordinatorId: coordinator.id,
      venueId: venue ? venue.id : null,
      startDatetime: new Date(start),
      endDatetime: new Date(end),
      status,
    });
  }

  return { suffix, createUser, login, makeEquipment, makeVenue, makeEvent };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { makeFixtures, auth, app, request };
