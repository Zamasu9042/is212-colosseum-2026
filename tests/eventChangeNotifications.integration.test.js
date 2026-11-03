const request = require('supertest');
const app = require('../src/app');
const {
  sequelize, Role, User, Venue, EventRequest, Event, EventRegistration, Notification, ROLE_NAMES,
} = require('../src/models');
const { hashPassword } = require('../src/utils/password');
const { signAccessToken } = require('../src/utils/jwt');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function account(roleName, label) {
  const [role] = await Role.findOrCreate({ where: { name: roleName }, defaults: { name: roleName, displayName: roleName } });
  return User.create({
    email: `event-change-${label}-${suffix}@example.com`, passwordHash: await hashPassword(PASSWORD),
    firstName: label, lastName: 'User', roleId: role.id,
  });
}
function token(user, roleName) {
  return signAccessToken({ id: user.id, email: user.email, roleName });
}

describe('event change attendee notifications', () => {
  let coordinator, attendee, coordinatorToken, attendeeToken, registration, event;

  beforeAll(async () => {
    const organiser = await account(ROLE_NAMES.EVENT_ORGANISER, 'Organiser');
    coordinator = await account(ROLE_NAMES.EVENT_COORDINATOR, 'Coordinator');
    attendee = await account(ROLE_NAMES.ATTENDEE, 'Attendee');
    const venue = await Venue.create({ name: `Change Hall ${suffix}`, location: 'Campus', capacity: 80 });
    const eventRequest = await EventRequest.create({ organiserId: organiser.id, eventName: 'Changed event', expectedAttendance: 80, status: 'approved' });
    event = await Event.create({
      eventRequestId: eventRequest.id, coordinatorId: coordinator.id, venueId: venue.id,
      startDatetime: new Date('2027-08-01T09:00:00Z'), endDatetime: new Date('2027-08-01T11:00:00Z'),
      status: 'confirmed', registrationCapacity: 80, availableCapacity: 79,
    });
    registration = await EventRegistration.create({ eventId: event.id, attendeeId: attendee.id, status: 'confirmed', confirmedAt: new Date() });
    coordinatorToken = token(coordinator, ROLE_NAMES.EVENT_COORDINATOR);
    attendeeToken = token(attendee, ROLE_NAMES.ATTENDEE);
  });

  afterAll(async () => { await sequelize.close(); });

  test('rescheduling creates detailed notice and lets the attendee re-confirm', async () => {
    const update = await request(app).patch(`/api/events/${event.id}`).set('Authorization', `Bearer ${coordinatorToken}`).send({
      startDatetime: '2027-08-02T10:00:00Z', endDatetime: '2027-08-02T12:00:00Z',
    });
    expect(update.status).toBe(200);
    expect(update.body.changes.map((change) => change.field)).toEqual(['startDatetime', 'endDatetime']);

    await registration.reload();
    expect(registration.status).toBe('awaiting_reconfirmation');
    const notice = await Notification.findOne({ where: { userId: attendee.id, eventId: event.id, type: 'event_changed' } });
    expect(notice.metadata).toMatchObject({ requiresReconfirmation: true });
    expect(notice.metadata.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Re-confirm registration', url: `/api/attendees/registrations/${registration.id}/reconfirm` }),
      expect.objectContaining({ label: 'Withdraw registration', url: `/api/attendees/registrations/${registration.id}/withdraw` }),
    ]));

    const reconfirm = await request(app).post(`/api/attendees/registrations/${registration.id}/reconfirm`)
      .set('Authorization', `Bearer ${attendeeToken}`);
    expect(reconfirm.status).toBe(200);
    expect(reconfirm.body.registration.status).toBe('confirmed');
  });
});
