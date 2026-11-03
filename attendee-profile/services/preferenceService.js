const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  emailNotifications: true,
  inAppNotifications: true,
});

function getDefaultNotificationPreferences() {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

function getNotificationPreferences(communicationPrefs) {
  const current = communicationPrefs && typeof communicationPrefs === 'object'
    ? communicationPrefs
    : {};

  return {
    emailNotifications:
      typeof current.emailNotifications === 'boolean'
        ? current.emailNotifications
        : DEFAULT_NOTIFICATION_PREFERENCES.emailNotifications,
    inAppNotifications:
      typeof current.inAppNotifications === 'boolean'
        ? current.inAppNotifications
        : DEFAULT_NOTIFICATION_PREFERENCES.inAppNotifications,
  };
}

function mergeNotificationPreferences(communicationPrefs, updates = {}) {
  const current = communicationPrefs && typeof communicationPrefs === 'object' ? communicationPrefs : {};
  const notificationPreferences = getNotificationPreferences(current);

  return {
    ...current,
    emailNotifications:
      typeof updates.emailNotifications === 'boolean'
        ? updates.emailNotifications
        : notificationPreferences.emailNotifications,
    inAppNotifications:
      typeof updates.inAppNotifications === 'boolean'
        ? updates.inAppNotifications
        : notificationPreferences.inAppNotifications,
  };
}

module.exports = {
  DEFAULT_NOTIFICATION_PREFERENCES,
  getDefaultNotificationPreferences,
  getNotificationPreferences,
  mergeNotificationPreferences,
};
