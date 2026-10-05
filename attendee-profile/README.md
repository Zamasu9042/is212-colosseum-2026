# Attendee Profile

This module lets an authenticated attendee view and update only their own contact profile.

## Endpoints

All endpoints require a valid attendee access token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/attendees/profile` | View the signed-in attendee's profile. |
| `PATCH` | `/api/attendees/profile` | Update contact details. |

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

## Security

Only accounts with the `attendee` role may use these endpoints. The user ID comes from the verified login token, so an attendee cannot view or edit someone else's profile. Internal roles, departments, passwords, IDs, and system configuration fields are rejected and never returned.

Notification preferences are deliberately not included yet because notification handling is not implemented elsewhere in the backend.

## Tests

Run the attendee-profile tests with:

```bash
npx jest attendee-profile/tests --runInBand
```
