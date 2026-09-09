const { User, Role, RefreshToken, ClientOrganisation } = require('../models');
const { hashPassword, comparePassword, isPasswordStrongEnough } = require('../utils/password');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  refreshExpiryDate,
} = require('../utils/jwt');

// Internal-staff roles cannot be self-assigned at public registration —
// those accounts should be provisioned by ConnectSphere administrators.
// Only external-facing roles are open for self-service sign-up.
const SELF_REGISTERABLE_ROLES = ['event_organiser', 'attendee'];

async function register(req, res, next) {
  try {
    const {
      email,
      password,
      firstName,
      lastName,
      phone,
      role, // must be one of SELF_REGISTERABLE_ROLES
      organisationName,
    } = req.body;

    if (!email || !password || !firstName || !lastName || !role) {
      return res.status(400).json({
        error: 'email, password, firstName, lastName, and role are required.',
      });
    }

    if (!SELF_REGISTERABLE_ROLES.includes(role)) {
      return res.status(403).json({
        error: `Self-registration is only permitted for roles: ${SELF_REGISTERABLE_ROLES.join(', ')}. Internal staff accounts are provisioned by ConnectSphere administrators.`,
      });
    }

    if (!isPasswordStrongEnough(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include a letter and a number.',
      });
    }

    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const roleRecord = await Role.findOne({ where: { name: role } });
    if (!roleRecord) {
      return res.status(400).json({ error: `Unknown role: ${role}` });
    }

    let organisationId = null;
    if (role === 'event_organiser' && organisationName) {
      const [org] = await ClientOrganisation.findOrCreate({
        where: { name: organisationName },
        defaults: { name: organisationName, contactEmail: email },
      });
      organisationId = org.id;
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      phone,
      roleId: roleRecord.id,
      organisationId,
    });

    return res.status(201).json({
      message: 'Account created successfully.',
      user: { ...user.toSafeJSON(), role: roleRecord.name },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const user = await User.findOne({ where: { email: email.toLowerCase() }, include: Role });

    // Use a generic error message for both "no such user" and "wrong
    // password" so we don't leak which emails are registered.
    const genericError = { error: 'Invalid email or password.' };

    if (!user || !user.isActive) {
      return res.status(401).json(genericError);
    }

    const passwordOk = await comparePassword(password, user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json(genericError);
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email, roleName: user.Role.name });
    const { token: refreshToken } = signRefreshToken({ id: user.id });

    await RefreshToken.create({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiryDate(),
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: refreshExpiryDate().getTime() - Date.now(),
    });

    return res.status(200).json({
      message: 'Login successful.',
      accessToken,
      user: { ...user.toSafeJSON(), role: user.Role.name },
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!token) {
      return res.status(401).json({ error: 'Refresh token required.' });
    }

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    const tokenHash = hashToken(token);
    const stored = await RefreshToken.findOne({
      where: { userId: payload.sub, tokenHash },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Refresh token has been revoked or expired.' });
    }

    const user = await User.findByPk(payload.sub, { include: Role });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Account not found or has been deactivated.' });
    }

    // Rotate: revoke the used refresh token and issue a new one.
    stored.revokedAt = new Date();
    await stored.save();

    const accessToken = signAccessToken({ id: user.id, email: user.email, roleName: user.Role.name });
    const { token: newRefreshToken } = signRefreshToken({ id: user.id });

    await RefreshToken.create({
      userId: user.id,
      tokenHash: hashToken(newRefreshToken),
      expiresAt: refreshExpiryDate(),
    });

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: refreshExpiryDate().getTime() - Date.now(),
    });

    return res.status(200).json({ accessToken });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;
    if (token) {
      const tokenHash = hashToken(token);
      await RefreshToken.update(
        { revokedAt: new Date() },
        { where: { tokenHash, revokedAt: null } }
      );
    }
    res.clearCookie('refreshToken');
    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
}

/** Returns the currently authenticated user's own profile. */
async function me(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id, { include: Role });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json({ user: { ...user.toSafeJSON(), role: user.Role.name } });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, refresh, logout, me };
