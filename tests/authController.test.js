const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const { Role, User, RefreshToken, ROLE_NAMES } = require('../src/models');
const { hashPassword } = require('../src/utils/password');
const { hashToken } = require('../src/utils/jwt');

const PASSWORD = 'Passw0rd1';
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const registration = (label, overrides = {}) => ({
  email: `auth-${label}-${suffix}@example.com`,
  password: PASSWORD,
  firstName: 'Auth',
  lastName: 'Tester',
  role: ROLE_NAMES.ATTENDEE,
  ...overrides,
});

const refreshTokenFrom = (response) => {
  const cookie = response.headers['set-cookie']?.find((value) => value.startsWith('refreshToken='));
  return cookie?.split(';')[0].slice('refreshToken='.length);
};

describe('Authentication controller and account enforcement', () => {
  async function createUser(label, roleName = ROLE_NAMES.ATTENDEE, overrides = {}) {
    const role = await Role.findOne({ where: { name: roleName } });
    return User.create({
      email: `auth-${label}-${suffix}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Auth',
      lastName: label,
      roleId: role.id,
      ...overrides,
    });
  }

  async function login(email, password = PASSWORD) {
    return request(app).post('/api/auth/login').send({ email, password });
  }

  test('rejects self-registration for an internal staff role', async () => {
    const payload = registration('internal', { role: ROLE_NAMES.EVENT_COORDINATOR });

    const response = await request(app).post('/api/auth/register').send(payload);

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Self-registration is only permitted for roles: event_organiser, attendee.');
    expect(await User.count({ where: { email: payload.email } })).toBe(0);
  });

  test('rejects a weak password during registration without creating an account', async () => {
    const payload = registration('weak-password', { password: 'lettersonly' });

    const response = await request(app).post('/api/auth/register').send(payload);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Password must be at least 8 characters and include a letter and a number.' });
    expect(await User.count({ where: { email: payload.email } })).toBe(0);
  });

  test('rejects registration when the email already exists regardless of case', async () => {
    const payload = registration('duplicate');
    expect((await request(app).post('/api/auth/register').send(payload)).status).toBe(201);

    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...payload, email: payload.email.toUpperCase() });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'An account with this email already exists.' });
    expect(await User.count({ where: { email: payload.email } })).toBe(1);
  });

  test('returns the same generic error for an unknown email and an incorrect password', async () => {
    const user = await createUser('invalid-login');

    const unknown = await login(`unknown-${suffix}@example.com`);
    const incorrectPassword = await login(user.email, 'WrongPassw0rd1');

    for (const response of [unknown, incorrectPassword]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid email or password.' });
      expect(response.body.accessToken).toBeUndefined();
      expect(refreshTokenFrom(response)).toBeUndefined();
    }
  });

  test('rotates a valid refresh token and rejects replay of the used token', async () => {
    const user = await createUser('refresh-rotation');
    const loggedIn = await login(user.email);
    const originalToken = refreshTokenFrom(loggedIn);

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${originalToken}`);
    const newToken = refreshTokenFrom(refreshed);
    const originalSession = await RefreshToken.findOne({ where: { tokenHash: hashToken(originalToken) } });
    const newSession = await RefreshToken.findOne({ where: { tokenHash: hashToken(newToken) } });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    expect(newToken).toEqual(expect.any(String));
    expect(newToken).not.toBe(originalToken);
    expect(originalSession.revokedAt).toBeInstanceOf(Date);
    expect(newSession).toMatchObject({ userId: user.id, revokedAt: null });

    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${originalToken}`);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Refresh token has been revoked or expired.' });
  });

  test('rejects a refresh token whose persisted session record has expired', async () => {
    const user = await createUser('expired-refresh');
    const loggedIn = await login(user.email);
    const token = refreshTokenFrom(loggedIn);
    await RefreshToken.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { tokenHash: hashToken(token) } }
    );

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);
    const session = await RefreshToken.findOne({ where: { tokenHash: hashToken(token) } });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Refresh token has been revoked or expired.' });
    expect(session.revokedAt).toBeNull();
    expect(await RefreshToken.count({ where: { userId: user.id } })).toBe(1);
  });

  test('revokes a supplied refresh cookie on logout and prevents later refresh', async () => {
    const user = await createUser('logout-revocation');
    const loggedIn = await login(user.email);
    const token = refreshTokenFrom(loggedIn);

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${token}`);
    const session = await RefreshToken.findOne({ where: { tokenHash: hashToken(token) } });
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${token}`);

    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ message: 'Logged out successfully.' });
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(refreshed.status).toBe(401);
    expect(refreshed.body).toEqual({ error: 'Refresh token has been revoked or expired.' });
  });

  test('rejects a refresh token presented as access credentials', async () => {
    const user = await createUser('refresh-as-access');
    const refreshToken = refreshTokenFrom(await login(user.email));

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${refreshToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid access token.' });
  });

  test('rejects an expired access token before loading the user', async () => {
    const user = await createUser('expired-access');
    const expiredToken = jwt.sign(
      { sub: user.id, role: ROLE_NAMES.ATTENDEE, email: user.email, type: 'access' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: -1 }
    );

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Access token expired.' });
  });

  test('rejects a valid access token after its account is deactivated', async () => {
    const user = await createUser('deactivated-access');
    const accessToken = (await login(user.email)).body.accessToken;
    await user.update({ isActive: false });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Account not found or has been deactivated.' });
  });

  test('returns the authenticated users safe profile without its password hash', async () => {
    const user = await createUser('me-profile');
    const accessToken = (await login(user.email)).body.accessToken;

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: user.id, email: user.email, role: ROLE_NAMES.ATTENDEE });
    expect(response.body.user.passwordHash).toBeUndefined();
  });
});
