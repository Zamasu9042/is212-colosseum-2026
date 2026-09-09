const { authorize } = require('../src/middleware/rbac');
const { ROLE_NAMES } = require('../src/models/Role');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('RBAC middleware: authorize()', () => {
  test('rejects unauthenticated requests with 401', () => {
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    authorize(ROLE_NAMES.VENUE_STAFF)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a user whose role is not in the allow-list with 403', () => {
    const req = { user: { role: ROLE_NAMES.ATTENDEE } };
    const res = mockRes();
    const next = jest.fn();

    authorize(ROLE_NAMES.VENUE_STAFF, ROLE_NAMES.EVENT_COORDINATOR)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows a user whose role is in the allow-list', () => {
    const req = { user: { role: ROLE_NAMES.VENUE_STAFF } };
    const res = mockRes();
    const next = jest.fn();

    authorize(ROLE_NAMES.VENUE_STAFF)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('enforces boundaries independently across all 5 roles', () => {
    const allRoles = Object.values(ROLE_NAMES);

    allRoles.forEach((role) => {
      const req = { user: { role } };
      const res = mockRes();
      const next = jest.fn();

      // Only technical_support_staff should pass this check.
      authorize(ROLE_NAMES.TECHNICAL_SUPPORT_STAFF)(req, res, next);

      if (role === ROLE_NAMES.TECHNICAL_SUPPORT_STAFF) {
        expect(next).toHaveBeenCalled();
      } else {
        expect(res.status).toHaveBeenCalledWith(403);
      }
    });
  });
});
