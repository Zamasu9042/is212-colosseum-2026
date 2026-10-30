// Web GUI hosting + supporting endpoints used by the GUI.
const { sequelize, ROLE_NAMES } = require('../src/models');
const { makeFixtures, auth, app, request } = require('./helpers/equipmentFixtures');

const fx = makeFixtures('gui');

describe('Web GUI hosting', () => {
  afterAll(async () => { await sequelize.close(); });

  test('GET / serves the single-page app', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<script src="/app.js"></script>');
  });

  test('static assets are served, including the tutorial system', async () => {
    expect((await request(app).get('/app.js')).status).toBe(200);
    const tutorial = await request(app).get('/tutorial.js');
    expect(tutorial.status).toBe(200);
    expect(tutorial.text).toContain('SCRUM-21');
    expect((await request(app).get('/')).text).toContain('<script src="/tutorial.js"></script>');
    expect((await request(app).get('/styles.css')).headers['content-type']).toMatch(/css/);
  });

  test('deep links fall back to index.html', async () => {
    const res = await request(app).get('/some/deep/link');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  test('unknown API paths still return JSON 401/404, never the SPA', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.headers['content-type']).toMatch(/json/);
    expect([401, 404]).toContain(res.status);
    const health = await request(app).get('/health');
    expect(health.body).toEqual({ status: 'ok' });
  });

  describe('GET /api/users (coordinator directory for Leads)', () => {
    let leadToken, coordToken, coordinator;
    beforeAll(async () => {
      const lead = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR_LEAD, 'lead');
      coordinator = await fx.createUser(ROLE_NAMES.EVENT_COORDINATOR, 'coord');
      [leadToken, coordToken] = await Promise.all([lead, coordinator].map(fx.login));
    });

    test('Lead can list coordinators without sensitive fields', async () => {
      const res = await request(app).get('/api/users?role=event_coordinator').set(auth(leadToken));
      expect(res.status).toBe(200);
      const me = res.body.users.find((u) => u.id === coordinator.id);
      expect(me).toBeDefined();
      expect(me.passwordHash).toBeUndefined();
    });

    test('other roles are refused; unlisted roles rejected', async () => {
      expect((await request(app).get('/api/users?role=event_coordinator').set(auth(coordToken))).status).toBe(403);
      expect((await request(app).get('/api/users?role=attendee').set(auth(leadToken))).status).toBe(400);
    });
  });

  test('organiser can list all own requests with scope=all', async () => {
    const organiser = await fx.createUser(ROLE_NAMES.EVENT_ORGANISER, 'org');
    const token = await fx.login(organiser);
    const { EventRequest } = require('../src/models');
    await EventRequest.create({ organiserId: organiser.id, eventName: 'Draft one', status: 'draft' });
    await EventRequest.create({ organiserId: organiser.id, eventName: 'Submitted one', status: 'submitted' });
    const drafts = await request(app).get('/api/event-requests').set(auth(token));
    expect(drafts.body.eventRequests).toHaveLength(1);
    const all = await request(app).get('/api/event-requests?scope=all').set(auth(token));
    expect(all.body.eventRequests).toHaveLength(2);
  });
});
