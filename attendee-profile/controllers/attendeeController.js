const { User } = require('../../src/models');

/**
 * GET /api/attendees/profile
 * Retrieves the authenticated attendee's profile.
 */
async function getProfile(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'Attendee account not found or has been deactivated.' });
    }

    return res.status(200).json({
      attendee: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        organization: user.organization,
        phone: user.phone,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/attendees/profile
 * Updates the authenticated attendee's personal details (firstName, lastName, phone).
 * Internal fields (roles, departments, IDs, passwords) are protected and rejected.
 */
async function updateProfile(req, res, next) {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'Attendee account not found or has been deactivated.' });
    }

    const fieldsToUpdate = {};
    if (req.body.firstName !== undefined) fieldsToUpdate.firstName = req.body.firstName.trim();
    if (req.body.lastName !== undefined) fieldsToUpdate.lastName = req.body.lastName.trim();
    if (req.body.phone !== undefined) {
      fieldsToUpdate.phone = req.body.phone ? req.body.phone.trim() : null;
    }
    if (req.body.organization !== undefined) {
      fieldsToUpdate.organization = req.body.organization ? req.body.organization.trim() : null;
    }
    if (req.body.email !== undefined) fieldsToUpdate.email = req.body.email;

    await user.update(fieldsToUpdate);

    return res.status(200).json({
      message: 'Profile updated successfully.',
      attendee: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        organization: user.organization,
        phone: user.phone,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfile,
  updateProfile,
};
