# Attendee Profile

This module lets an authenticated attendee view and update only their own contact profile and notification settings.

## Endpoints

All endpoints require a valid attendee access token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/attendees/profile` | View the signed-in attendee's profile. |
| `PATCH` | `/api/attendees/profile` | Update contact details. |
| `GET` | `/api/attendees/preferences` | View email and in-app notification settings. |
| `PATCH` | `/api/attendees/preferences` | Update email and in-app notification settings. |
| `GET` | `/api/attendees/registrations` | List the attendee's event registrations and withdrawal eligibility. |
| `POST` | `/api/attendees/registrations` | Create a confirmed registration when an event has capacity. |
| `POST` | `/api/attendees/registrations/:id/withdraw` | Withdraw a confirmed registration before the event starts. |
| `POST` | `/api/attendees/registrations/:id/reconfirm` | Re-confirm a registration after an event is rescheduled. |

Example update request:

```json
{
  "firstName": "Alex",
  "lastName": "Tan",
  "organization": "ConnectSphere Society",
  "phone": "+6591234567",
  "email": "alex@example.com"
}
```

At least one field is required. Email addresses must be valid.

Example notification update request:

```json
{
  "emailNotifications": true,
  "inAppNotifications": false
}
```

Both values must be JSON booleans (`true` or `false`). New attendees default to both notification types enabled. Notification settings use the existing `users.communication_prefs` field and preserve unrelated stored preferences.

## Event registrations and withdrawal

Events track `registrationCapacity` and `availableCapacity`. A confirmed registration immediately decreases available capacity; a successful withdrawal changes the registration status to `withdrawn` and immediately restores one place.

The registrations endpoint returns `canWithdraw`. It is `false` when a registration is already withdrawn, the event has started, or the event is completed/cancelled. The withdrawal endpoint enforces the same rule server-side.

On withdrawal, ConnectSphere creates an in-app confirmation (unless the attendee opted out of in-app notifications) and sends a Gmail SMTP confirmation email (unless they opted out of email notifications).

## Event changes

An assigned Event Coordinator can update an active event with `PATCH /api/events/:id` using any combination of `startDatetime`, `endDatetime`, `venueId`, and `status`. Every attendee with an active registration is notified immediately in-app and by email (subject to their notification preferences). The notification's `metadata.changes` supplies labelled before/after values for every changed date, time, venue, or status.

When either event time changes, registrations remain reserved but move to `awaiting_reconfirmation`. The notification's `metadata.actions` contains authenticated `POST` links to re-confirm or withdraw the registration; the same links are included in the email. Re-confirming changes the registration back to `confirmed` without consuming another place.

## Security

Only accounts with the `attendee` role may use these endpoints. The user ID comes from the verified login token, so an attendee cannot view or edit someone else's profile. Internal roles, departments, passwords, IDs, and system configuration fields are rejected and never returned.

The in-app toggle is stored alongside the existing notification system's user settings. This backend does not currently include an email delivery service, so the email toggle is stored for use when that service is added.

## Tests

Run the attendee-profile tests with:

```bash
npx jest attendee-profile/tests --runInBand
```
