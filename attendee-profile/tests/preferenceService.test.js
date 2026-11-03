const {
  getDefaultNotificationPreferences,
  getNotificationPreferences,
  mergeNotificationPreferences,
} = require('../services/preferenceService');

describe('Notification preference service', () => {
  test('returns independent defaults for both notification toggles', () => {
    expect(getDefaultNotificationPreferences()).toEqual({
      emailNotifications: true,
      inAppNotifications: true,
    });
  });

  test('applies defaults to missing or malformed stored values', () => {
    expect(getNotificationPreferences({ emailNotifications: false, inAppNotifications: 'yes' }))
      .toEqual({ emailNotifications: false, inAppNotifications: true });
  });

  test('updates notification toggles while retaining unrelated preferences', () => {
    expect(mergeNotificationPreferences(
      { preferredLanguage: 'en', emailNotifications: true, inAppNotifications: true },
      { emailNotifications: false }
    )).toEqual({
      preferredLanguage: 'en',
      emailNotifications: false,
      inAppNotifications: true,
    });
  });
});
