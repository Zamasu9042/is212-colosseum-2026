const { sequelize, ROLE_NAMES } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('registration-window');

describe('Confirmed-event registration windows', () => {
  let organiser;
  let coordinator;
  let attendee;
  let coordinatorToken;
  let attendeeToken;
  let event;

  beforeAll(async () => {
    organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'organiser');
    coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coordinator');
    attendee = await fx.createUser(ROLE_NAMES.ATTENDEE, 'attendee');
    [coordinatorToken, attendeeToken] = await Promise.all([coordinator, attendee].map(fx.login));
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    event = await fx.makeEvent({ organiser, coordinator, status: 'confirmed', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString() });
    await event.update({ registrationCapacity: 5, availableCapacity: 5 });
  });

  afterAll(async () => { await sequelize.close(); });

  const registrationBody = () => ({ eventId: event.id, fullName: 'Alex Tan', workEmail: 'alex.tan@example.com', contactNumber: '+6591234567' });

  test('does not expose an unconfigured event as open and rejects its registration', async () => {
    const events = await request(app).get('/api/attendees/registrations/events').set(auth(attendeeToken));
    expect(events.body.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id, registrationOpen: false, registrationUnavailableReason: 'Registration window has not been configured.' })]));
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeToken)).send(registrationBody())).status).toBe(409);
  });

  test('coordinator configures a valid window; invalid windows are rejected', async () => {
    const start = new Date(Date.now() - 60 * 60 * 1000);
    const end = new Date(Date.now() + 60 * 60 * 1000);
    const configured = await request(app).patch(`/api/events/${event.id}`).set(auth(coordinatorToken)).send({ registrationStartDatetime: start.toISOString(), registrationEndDatetime: end.toISOString() });
    expect(configured.status).toBe(200);
    expect(configured.body.event.registrationStartDatetime).toBeTruthy();
    const invalid = await request(app).patch(`/api/events/${event.id}`).set(auth(coordinatorToken)).send({ registrationStartDatetime: end.toISOString(), registrationEndDatetime: start.toISOString() });
    expect(invalid.status).toBe(400);
    const movedBeforeClose = await request(app).patch(`/api/events/${event.id}`).set(auth(coordinatorToken)).send({
      startDatetime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    expect(movedBeforeClose.status).toBe(400);
  });

  test('requires valid contact snapshots and persists a confirmed registration in the open window', async () => {
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeToken)).send({ eventId: event.id })).status).toBe(400);
    expect((await request(app).post('/api/attendees/registrations').set(auth(attendeeToken)).send({ ...registrationBody(), contactNumber: '123' })).status).toBe(400);
    const created = await request(app).post('/api/attendees/registrations').set(auth(attendeeToken)).send(registrationBody());
    expect(created.status).toBe(201);
    expect(created.body.registration).toMatchObject({ status: 'confirmed', fullName: 'Alex Tan', workEmail: 'alex.tan@example.com', contactNumber: '+6591234567' });
    expect(created.body.availableCapacity).toBe(4);
  });
});
