const { sequelize, ROLE_NAMES } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('registration-ui');

describe('Attendee registration discovery and capacity', () => {
  let attendeeA;
  let attendeeB;
  let attendeeAToken;
  let attendeeBToken;
  let event;

  beforeAll(async () => {
    const organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'organiser');
    const coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator');
    attendeeA = await fx.createUser(ROLE_NAMES.ATTENDEE, 'attendee-a');
    attendeeB = await fx.createUser(ROLE_NAMES.ATTENDEE, 'attendee-b');
    // Keep this integration test offline; email delivery itself is covered by
    // the controller unit tests.
    await attendeeA.update({ communicationPrefs: { emailNotifications: false } });
    [attendeeAToken, attendeeBToken] = await Promise.all([attendeeA, attendeeB].map(fx.login));
    const eventStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const eventEnd = new Date(eventStart.getTime() + 2 * 60 * 60 * 1000);
    event = await fx.makeEvent({
      organiser, coordinator, status: 'confirmed',
      start: eventStart.toISOString(), end: eventEnd.toISOString(), name: 'One Place Event',
    });
    await event.update({ registrationCapacity: 1, availableCapacity: 1 });
    await event.update({
      registrationStartDatetime: new Date(Date.now() - 60 * 60 * 1000),
      registrationEndDatetime: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  afterAll(async () => { await sequelize.close(); });

  test('attendees can discover, register, prevent duplicates/full capacity, then withdraw to release the place', async () => {
    const listed = await request(app).get('/api/attendees/registrations/events').set(auth(attendeeAToken));
    expect(listed.status).toBe(200);
    expect(listed.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: event.id, name: 'One Place Event', availableCapacity: 1 }),
    ]));

    const registrationBody = { eventId: event.id, fullName: 'Attendee A', workEmail: 'attendee-a@example.com', contactNumber: '+6591234567' };
    const registered = await request(app).post('/api/attendees/registrations').set(auth(attendeeAToken)).send(registrationBody);
    expect(registered.status).toBe(201);
    expect(registered.body.availableCapacity).toBe(0);
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeAToken)).send(registrationBody)).status).toBe(409);
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeBToken)).send({ ...registrationBody, fullName: 'Attendee B', workEmail: 'attendee-b@example.com' })).status).toBe(409);

    const withdrawn = await request(app).post(`/api/attendees/registrations/${registered.body.registration.id}/withdraw`).set(auth(attendeeAToken));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.availableCapacity).toBe(1);
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeBToken)).send({ ...registrationBody, fullName: 'Attendee B', workEmail: 'attendee-b@example.com' })).status).toBe(201);
  });
});
