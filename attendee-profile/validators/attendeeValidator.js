const { body } = require('express-validator');
const IMMUTABLE_FIELDS = [
  'id',
  'role',
  'roleId',
  'role_id',
  'password',
  'passwordHash',
  'password_hash',
  'isActive',
  'is_active',
  'department',
  'organisationId', // internal relationship; attendees may edit `organization` only
  'organisation_id',
];

const validateProfileUpdate = [
  body().custom((value, { req }) => {
    // Detect attempts to alter immutable account/role fields
    const attemptedImmutable = IMMUTABLE_FIELDS.filter((field) => field in req.body);
    if (attemptedImmutable.length > 0) {
      throw new Error(
        `Immutable fields cannot be updated: ${attemptedImmutable.join(', ')}.`
      );
    }

    const { firstName, lastName, organization, phone, email } = req.body;
    if (firstName === undefined && lastName === undefined && organization === undefined && phone === undefined && email === undefined) {
      throw new Error('At least one profile field must be provided for update.');
    }
    return true;
  }),
  body('firstName')
    .optional()
    .isString()
    .withMessage('First name must be a string.')
    .trim()
    .notEmpty()
    .withMessage('First name cannot be empty.')
    .isLength({ max: 100 })
    .withMessage('First name cannot exceed 100 characters.'),
  body('lastName')
    .optional()
    .isString()
    .withMessage('Last name must be a string.')
    .trim()
    .notEmpty()
    .withMessage('Last name cannot be empty.')
    .isLength({ max: 100 })
    .withMessage('Last name cannot exceed 100 characters.'),
  body('phone')
    .optional({ nullable: true })
    .isString()
    .withMessage('Phone must be a string.')
    .trim()
    .isLength({ max: 30 })
    .withMessage('Phone number cannot exceed 30 characters.'),
  body('organization')
    .optional({ nullable: true })
    .isString()
    .withMessage('Organization must be a string.')
    .trim()
    .isLength({ max: 200 })
    .withMessage('Organization cannot exceed 200 characters.'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Email must be a valid email address.')
    .normalizeEmail(),
];

module.exports = {
  validateProfileUpdate,
  IMMUTABLE_FIELDS,
};
