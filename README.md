# is212-colosseum-2026

ConnectSphere Event Planning & Venue Booking System — REST API plus a
browser-based GUI.

## Quick start (web GUI)

You need **Node.js 18+** and **PostgreSQL 14+**. With Docker, PostgreSQL is
one command.

```bash
npm install
cp .env.example .env          # defaults match the Docker database below
docker compose up -d          # or use your own PostgreSQL (see step 2)
npm run setup                 # schema + roles + demo data
npm start
```

Open **http://localhost:4000** and sign in. The login page has one-click
buttons for the demo accounts (password `Passw0rd1` for all):

| Account | Role | Try this |
|---|---|---|
| `organiser@demo.connectsphere.sg` | Event Organiser | Draft and submit an event request |
| `coordinator@demo.connectsphere.sg` | Event Coordinator | Review queue → approve *Data Science Workshop*; request a venue; add equipment needs |
| `lead@demo.connectsphere.sg` | Coordinator Lead | Assign *Partner Networking Night* to a coordinator |
| `venue@demo.connectsphere.sg` | Venue Staff | Approve/reject venue bookings; venue schedule |
| `tech@demo.connectsphere.sg` | Technical Support | Equipment catalogue; open *Annual Leadership Summit* to reserve equipment and complete technical readiness |
| `safety@demo.connectsphere.sg` | Safety Officer | Read-only events and equipment |
| `attendee@demo.connectsphere.sg` | Attendee | Edit profile |

The GUI is a dependency-free single-page app in `public/`, served by the same
Express server as the API, so there's no separate build or frontend server. All rules
are enforced by the API, and the GUI only presents them. It works on desktop and mobile.

**Tutorials.** On a user's first sign-in, a guided "Getting started" tour for their role
starts automatically. **Help & tutorials** in the sidebar (or the **? Help** button) lets them
replay it and start the feature tutorials: *Manage equipment status* (SCRUM-22), *Reserve
equipment for an event* (SCRUM-21) and *Complete technical readiness* (SCRUM-24) for Technical
Support Staff. The Help page also has written quick guides, a status glossary and FAQs. Tours
only point things out and never change data. Progress is remembered per user in the browser,
and **Reset progress** on the Help page starts over. The code is in `public/tutorial.js`.

`npm run db:reset && npm run db:demo` restores the demo data.

---

## Getting Started (detailed)

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 14+ (running locally, in Docker, or a hosted instance)
- Git

### 1. Clone and install dependencies

```bash
git clone <your-repo-url>
cd task1-db-auth
npm install
```

### 2. Set up PostgreSQL

Create an empty database for the project:

```bash
# using psql
createdb connectsphere

# or from inside psql
psql -U postgres -c "CREATE DATABASE connectsphere;"
```

**Using Docker instead?**

```bash
docker run --name connectsphere-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=connectsphere \
  -p 5432:5432 -d postgres:16
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env`:

- Update `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` to match your PostgreSQL setup.
- Replace `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` with your own long, random strings (e.g. run `openssl rand -hex 32` twice). **Never commit real secrets.**

### 4. Initialise the database

```bash
npm run db:init    # applies the schema (tables, constraints, triggers)
npm run db:seed    # inserts the system roles
npm run db:demo    # optional: demo accounts + sample venues, equipment, events
# or all three at once: npm run setup
```

> Need to start over during development? `npm run db:reset` drops and rebuilds everything (blocked automatically if `NODE_ENV=production`).

### 5. Run the server

```bash
npm run dev     # with auto-reload (nodemon)
# or
npm start       # plain node
```

The web GUI is at `http://localhost:4000/` and the API under `http://localhost:4000/api` (or whatever `PORT` you set). Confirm it's up:

```bash
curl http://localhost:4000/health
# {"status":"ok"}
```

### 6. Try the auth flow

```bash
# Register an Event Organiser
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"organiser@example.com","password":"Passw0rd1","firstName":"Jane","lastName":"Tan","role":"event_organiser"}'

# Log in
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"organiser@example.com","password":"Passw0rd1"}'
# → returns an accessToken; use it as: Authorization: Bearer <token>
```

### 6a. Try venue searching and filtering

```bash
# Search by name or location, filter by capacity/type/facilities, sort results
curl -G http://localhost:4000/api/venues \
  -H "Authorization: Bearer <accessToken>" \
  --data-urlencode "search=marina" \
  --data-urlencode "minCapacity=100" \
  --data-urlencode "venueType=Ballroom,Auditorium" \
  --data-urlencode "facilities=projector,wifi" \
  --data-urlencode "availability=available" \
  --data-urlencode "sortBy=capacity" \
  --data-urlencode "sortOrder=desc"

# Check a specific venue against a proposed date/time (accounts for the
# venue's own setup/teardown turnaround time), then select it for review
curl -G http://localhost:4000/api/venues/<venueId> \
  -H "Authorization: Bearer <accessToken>" \
  --data-urlencode "startDateTime=2026-10-01T09:00:00Z" \
  --data-urlencode "endDateTime=2026-10-01T12:00:00Z"
```

Supported `GET /api/venues` query params (all optional, combinable):
`search`, `name`, `location`, `minCapacity`/`capacity`, `maxCapacity`,
`venueType` (comma-separated), `facilities` (comma-separated, venue must
have all), `availability` (`available`|`unavailable`), `startDateTime` +
`endDateTime` (ISO8601, required together), `sortBy`
(`name`|`location`|`capacity`|`availability`), `sortOrder` (`asc`|`desc`).
When nothing matches, the response includes a `message` field alongside
an empty `venues` array.

### Venue availability calendar

Event Coordinators can request a render-ready timeline with `GET
/api/venues/availability`. Filter it by `date=YYYY-MM-DD` or an explicit
`startDateTime`/`endDateTime` pair, and optionally by one or more comma-separated
`venueId` values. Each venue returns ordered `slots` with a machine-readable
`state`, a `displayState`, and `isAvailable`:

- `available` — Available
- `tentative_hold` — Tentative Hold (`planning` or `awaiting_arrangements` event)
- `confirmed_booking` — Confirmed Booking
- `temporarily_unavailable` — venue is blocked or under maintenance
- `expired_hold` — cancelled reservation; visible for context but requestable

Every reservation slot is extended by the venue's `setupMinutes` and
`teardownMinutes`, so the available portions can safely be requested.

### Venue setup and turnaround configuration

Venue Staff can set timing when creating or updating a venue with `POST` or
`PATCH /api/venues/:id`. Send `setupMinutes` and either `turnaroundMinutes`
(preferred) or the backwards-compatible `teardownMinutes`; values are whole
minutes from 0 to 1440. The response exposes both `turnaroundMinutes` and
`teardownMinutes`.

Timing updates return `hasConflicts` and a `conflicts` list when they cause
existing tentative or confirmed reservations to overlap. No reservation is
removed: each conflict reports the two existing event IDs and their shared
effective occupied interval.

### 6b. Venue schedule conflict identification

Checks a proposed booking against one or more venues. Each venue is evaluated
**independently** and gets its own result. Venue Staff and Event Coordinators only.

```bash
curl -X POST http://localhost:4000/api/venues/conflicts \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{"venueIds":["<venueA>","<venueB>"],
       "startDateTime":"2026-10-01T15:00:00Z","endDateTime":"2026-10-01T17:00:00Z",
       "excludeEventId":"<optional: re-check an existing event without self-conflict>"}'
```

The response holds `hasConflicts` plus, for each venue, its `effectiveWindow` and a
`conflicts` list. Each conflict has a `type`:

| type | Meaning |
|---|---|
| `booking` | An event that isn't cancelled (`planning`, `awaiting_arrangements`, `confirmed`, `completed`) |
| `tentative_hold` | An **active** hold: `status = active` and `expires_at` is in the future |
| `unavailability` | A recorded unavailability period (includes its `reason`) |
| `venue_status` | The venue is marked `maintenance` / `blocked` |

**Effective occupied period** = `[start − setupMinutes, end + teardownMinutes)` of the
venue. This applies to the proposed booking **and** to existing bookings/holds. With
30/30 buffers, two events need a 60-minute gap between them. Unavailability periods are
not buffered, but the new booking's own setup/teardown cannot overlap them. Windows that
only touch do not conflict.

Supporting endpoints:

| Method & path | Who | Notes |
|---|---|---|
| `GET /api/venues/:id/holds` | Staff, Coordinator | Includes computed `isActive` |
| `POST /api/venues/:id/holds` | Staff, Coordinator | `startDateTime`, `endDateTime`, optional `expiresAt` (defaults to 72h, capped at the slot start; see 6d), `eventId`, `notes`. **409** with conflict details if it would double-book. Concurrent requests are serialised by a row lock on the venue |
| `PATCH /api/venues/:id/holds/:holdId/release` | Staff, or the Coordinator who placed it | **409** if the hold is no longer active, including once its deadline has passed |
| `GET /api/venues/:id/unavailability` | Staff, Coordinator | |
| `POST /api/venues/:id/unavailability` | Staff | `startDateTime`, `endDateTime`, `reason`. Always recorded; response lists `affected` bookings/holds and a `conflictAudit` (see 6e) |
| `DELETE /api/venues/:id/unavailability/:periodId` | Staff | Re-audits the venue, clearing flags that only existed because of this period |

Venue search (`GET /api/venues`, `GET /api/venues/:id`) uses the same rules, so
`isAvailable` also reflects holds and unavailability periods.

For future booking-request/approval routes, call
`assertNoVenueConflicts()` from `src/services/venueConflictService.js` inside a
transaction after `lockVenues()`. It throws a 409 `VenueConflictError`.

**Test traceability**

| AC | Unit (`tests/venueConflicts.test.js`) | Integration (`tests/venue.conflicts.test.js`) |
|---|---|---|
| Setup/turnaround | `AC — Setup/turnaround` | `AC — Setup/turnaround` |
| Tentative holds | `AC — Tentative holds` | `AC — Tentative holds` (incl. concurrency) |
| Venue unavailability | `AC — Venue unavailability` | `AC — Venue unavailability` |
| Multiple venues | `AC — Multiple venues` | `AC — Multiple venues` |

> Existing databases: run `npm run db:init` again. It is idempotent and adds the new
> `venue_holds` and `venue_unavailability` tables.

### 6c. Venue Staff booking decisions

Venue Staff can work the pending reservation queue and search it by event
details or organiser name/email:

```bash
# Submitted/under-review requests awaiting a decision
curl -G http://localhost:4000/api/event-requests/booking-requests/pending \
  -H "Authorization: Bearer <venueStaffAccessToken>" \
  --data-urlencode "search=leadership"

# Accepted (`approved`) and rejected decision history
curl -G http://localhost:4000/api/event-requests/booking-requests/history \
  -H "Authorization: Bearer <venueStaffAccessToken>" \
  --data-urlencode "search=leadership"

# Approve, or use status=rejected with a non-empty reviewReason to reject
curl -X PATCH http://localhost:4000/api/event-requests/<requestId>/status \
  -H "Authorization: Bearer <venueStaffAccessToken>" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'
```

The API's existing `approved` status represents an accepted booking. Both
queue endpoints are restricted to the `venue_staff` role and return organiser
details needed to make the decision.

For a decision-ready view of one request, Venue Staff can call:

```bash
curl http://localhost:4000/api/event-requests/booking-requests/<requestId> \
  -H "Authorization: Bearer <venueStaffAccessToken>"
```

The response contains `bookingDetails` (date/time, attendance, requested
layout, accessibility, facilities, and setup requirements), `missingDetails`,
and `isReadyForApproval`. Venue Staff cannot approve a request until it has an
event name, start/end date and time, positive attendance, requested layout,
accessibility needs, facility requirements, and setup requirements. An
incomplete request may still be rejected with a reason.

### 6d. Expiring tentative venue holds (Week 7)

Every tentative hold has a deadline. A hold blocks its venue/time slot only
until then, and expired holds are never treated as bookings.

| AC | How it works |
|---|---|
| AC1 Expiry required | `venue_holds.expires_at` is `NOT NULL`. If `POST /api/venues/:id/holds` has no `expiresAt`, the hold gets `HOLD_DEFAULT_DURATION_HOURS` (72h), capped at the slot start. An explicit `expiresAt` must be in the future and no later than the slot start (**400** otherwise). |
| AC2 Active hold blocks | Conflict checks, venue search and booking requests treat an active hold (`status = active` and `expires_at > now`) as unavailable, including setup/turnaround time. |
| AC3 Automatic expiry | A background sweep (started in `server.js`, every `HOLD_EXPIRY_SWEEP_INTERVAL_MS`, default 60s) moves due holds to `status = 'expired'` and stamps `expired_at`. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so parallel sweeps never double-process. |
| AC4 Release venue | Conflict detection ignores a hold from the exact moment `expires_at` passes, even before the sweep runs, so the slot can be booked straight away. |
| AC5 Not a booking | `expired` is its own status, separate from `converted`. Hold responses include `effectiveStatus`, which shows `expired` as soon as the deadline passes. An expired hold cannot be released or acted on. |
| AC6 Coordinator notified | The event's coordinator and whoever placed the hold get a `venue_hold_expiring` notification once, `HOLD_EXPIRY_WARNING_HOURS` (24h) before the deadline, and a `venue_hold_expired` notification when it expires. Both carry `venueHoldId` and appear in `GET /api/notifications`. |
| AC7 Booking request after expiry | **TBD (customer).** For now, expiry does not change any booking request. A pending request stays pending. |
| AC8 Hold extension | **TBD (customer).** There is no extend endpoint, and an expiry cannot be moved once set. |

| Method & path | Who | Notes |
|---|---|---|
| `GET /api/venues/holds/expiring?withinHours=24` | Staff, Coordinator | Active holds expiring within the window, soonest first. Coordinators only see holds they placed or that belong to their events. |
| `POST /api/venues/holds/process-expiries` | Staff | Runs the sweep now and returns what was expired and who was warned. |

> Existing databases: run `npm run db:init` again. Legacy holds without an expiry are
> given `created_at + 72h` (capped at the slot start) before the column becomes `NOT NULL`.

### 6e. Conflict detection under the updated booking rules (Week 7)

New booking requests, holds, venue search and `POST /api/venues/conflicts` all use the
same rules: the venue's **setup time** before the event and **turnaround time** after it,
**active tentative holds**, **temporary unavailability periods** and the venue status.
For a **multi-venue** event, each venue is checked on its own.

**Existing bookings that conflict under these rules are flagged and preserved, not deleted.**
The audit re-checks every live reservation of a venue. That covers pending/approved
`venue_bookings` and events booked straight onto a venue (`events.venue_id`).

- Conflicting reservation: `conflict_flagged_at` + `conflict_details` are set on
  `venue_bookings` (on `events`: `venue_conflict_flagged_at` + `venue_conflict_details`).
  The event's coordinator gets one `venue_booking_conflict_flagged` notification.
- Its status, times, venue and requirements are **never** changed, and nothing is deleted
  or cancelled.
- Once the reservation no longer conflicts, the flag is cleared. This includes a booking
  that is re-timed and passes the checks, or one that gets approved.

When the audit runs:

| Trigger | Scope |
|---|---|
| `PATCH /api/venues/:id` changes `setupMinutes`, `teardownMinutes` or `status` | That venue. The response includes `conflictAudit` |
| `POST`/`DELETE /api/venues/:id/unavailability` | That venue |
| `POST /api/venues/conflicts/audit` `{ "venueIds": [...] }` (Venue Staff) | The given venues, or every venue with live reservations if omitted. Run it once after deploying Week 7 so bookings accepted under the old rules get re-checked |

To list flagged bookings, Venue Staff can call `GET /api/venue-bookings?flagged=true` (optionally with `&venueId=`).

**Test traceability (Week 7)**

| Story / AC | Unit | Integration |
|---|---|---|
| Expiring holds AC1–AC6 | `tests/holdExpiry.test.js` | `tests/venueHoldExpiry.test.js` |
| Expiring holds AC7 (current behaviour) | – | `tests/venueHoldExpiry.test.js` → `AC7` |
| Setup / turnaround, unavailability, multiple venues (requests) | `tests/venueConflicts.test.js` | `tests/venueConflictAudit.test.js` → `new booking requests` |
| Existing bookings flagged and preserved | `tests/venueConflicts.test.js` → `Existing bookings re-checked` | `tests/venueConflictAudit.test.js` → `existing bookings`, `audit covers` |

### 6f. Equipment status, reservations and technical readiness (SCRUM-21, SCRUM-22, SCRUM-24)

**Equipment status (SCRUM-22).** Each item is `available`, `reserved`, `in_repair` or
`unavailable`. `reserved` is **system-managed**: it is set while the item has at least one
live reservation, and cleared when the last one is cancelled. It cannot be set by hand.
`in_repair`/`unavailable` items are never selectable and never reservable. Existing rows
are migrated `maintenance → in_repair`, `damaged → unavailable` by `npm run db:init`.

**Reservations (SCRUM-21, SCRUM-24).** A reservation commits `quantity` units of one item
to one approved event for a window, which defaults to the event's own start/end. A custom
window must lie inside it. Two reservations of the same item overlap when each starts before
the other ends. **There is no setup, turnaround or transit buffer**, even across venues, so
`10:00–12:00` and `12:00–14:00` don't conflict. A multi-unit item only conflicts once its
units in service (`quantityAvailable`) run out. The item row is locked inside the
transaction, so concurrent requests can't double-book it.

**Technical readiness (SCRUM-24).** An event's equipment needs are recorded as request
lines (e.g. `2 × Projector`, optionally pinned to one item). A reservation can be linked to
a line. Its item must match the line's type (or pinned item) and can't exceed what the line
still needs. Readiness can only be marked `complete` when every line is fully allocated.
It goes back to `pending` automatically if a covering reservation is cancelled or a new line
is added.

| Method & path | Who | Notes |
|---|---|---|
| `GET /api/equipment` | Coordinator, Lead, Tech, Safety | `status=available` or `status=in_repair,unavailable`; `type`; `search`; `selectable=true` drops in-repair/unavailable items, and with `eventId=` or `startDatetime`+`endDatetime` also drops items with no free unit in that window (adds `availableQuantity`) |
| `GET /api/equipment/:id` | same | Item plus all its reservations (equipment detail page) |
| `POST /api/equipment` · `PATCH /api/equipment/:id` | Tech | `status` may only be `available`/`in_repair`/`unavailable` |
| `PATCH /api/equipment/:id/status` | Tech | `{ status }`. Taking a reserved item out of service keeps its reservations and returns them as `affectedReservations` + `warning` |
| `GET /api/events` | Tech, Coordinator (own), Lead, Safety, Venue Staff | `?status=planning,confirmed` |
| `GET /api/events/:id` | Tech, Coordinator (own), Lead, Safety | Includes `equipmentReservations` and `equipmentAllocation` (event detail page) |
| `GET /api/events/:id/equipment-reservations` | Tech, Coordinator (own), Lead, Safety | |
| `POST /api/events/:id/equipment-reservations` | Tech | `{ equipmentId, quantity?, startDatetime?, endDatetime?, equipmentRequestId? }`. **409** overlap conflict with `conflicts[]`; **422** in-repair/unavailable item, window outside the event, line mismatch |
| `POST /api/equipment-reservations/:id/cancel` | Tech | `{ reason? }`. Item reverts to `available` when nothing else holds it; response has `readinessReverted` |
| `GET /api/equipment-reservations` | Tech, Lead | `equipmentId`, `eventId`, `status` filters |
| `GET/POST /api/events/:id/equipment-requests` | Coordinator (own), Tech (POST); readers as above (GET) | `{ equipmentType or equipmentId, quantityRequested, technicalRequirements? }`. GET includes per-line allocation |
| `DELETE /api/events/:id/equipment-requests/:requestId` | Coordinator (own), Tech | **409** while reservations are allocated to it |
| `GET /api/events/:id/technical-readiness` | readers as above | `canComplete` + allocation summary |
| `PATCH /api/events/:id/technical-readiness` | Tech | `{ complete: true }` → **409** listing shortfalls unless fully allocated; `{ complete: false }` resets |

Every reservation stores `eventId`, `equipmentId`, `organiserName` (snapshot), `reservedAt`
and `reservedBy`. Cancelled reservations are kept with `cancelledAt`, `cancelledBy` and
`cancellationReason`. The event's coordinator is notified when equipment is reserved or a
reservation is cancelled.

**Test traceability**

| Story / AC | Unit (`tests/equipmentAvailability.test.js`) | Integration |
|---|---|---|
| SCRUM-22 AC1 selectable list | `SCRUM-22 AC1/AC2` | `tests/equipment.status.test.js` → `AC1` |
| SCRUM-22 AC2 block in-repair/unavailable | `SCRUM-22 AC1/AC2` | `tests/equipment.status.test.js` → `AC2` |
| SCRUM-22 AC3 status filter | `SCRUM-22 AC3` | `tests/equipment.status.test.js` → `AC3` |
| SCRUM-21 AC1 available → reserved | `SCRUM-21 AC1/AC5` | `tests/equipment.reservation.test.js` → `AC1` |
| SCRUM-21 AC2 overlap conflict | `SCRUM-21 AC2` | `tests/equipment.reservation.test.js` → `AC2` (incl. concurrency) |
| SCRUM-21 AC3 metadata | – | `tests/equipment.reservation.test.js` → `AC3` |
| SCRUM-21 AC4 event + equipment pages | – | `tests/equipment.reservation.test.js` → `AC4` |
| SCRUM-21 AC5 cancel reverts | `SCRUM-21 AC1/AC5` | `tests/equipment.reservation.test.js` → `AC5` |
| SCRUM-24 AC1/AC2 time-slot overlap, no transit | `SCRUM-24 AC1/AC2` | `tests/equipment.readiness.test.js` → `AC1`, `AC2` |
| SCRUM-24 AC3 full allocation for readiness | `SCRUM-24 AC3` | `tests/equipment.readiness.test.js` → `AC3` |

**Related changes.** Coordinator approval (`PATCH /api/event-requests/:id/status`
`{status:'approved'}`) now creates the request's `Event` row (status `planning`), so newly
approved requests can have venues and equipment arranged. `GET /api/event-requests?scope=all`
returns every request the organiser owns (the default is still drafts only).
`GET /api/users?role=event_coordinator` (Lead only) lists coordinators for assignment.

> Existing databases: run `npm run db:init` again. It is idempotent.

### Bug fixes (October code review)

Each fix has a regression test named after its bug id.

| Bug | Problem | Fix | Test |
|---|---|---|---|
| BUG-1 | Two concurrent venue booking requests or approvals for the same slot could both pass the conflict check (double-booking) | Check and write run in one transaction under a venue row lock (`withVenueLock`) | `tests/bugfixes.venue.test.js` |
| BUG-2 | The venue calendar ignored venue booking requests, active holds and unavailability periods | Calendar uses the same sources as the booking check: pending booking → tentative hold, approved → confirmed, unavailability → temporarily unavailable | `tests/bugfixes.venue.test.js` |
| BUG-3 | An item stayed `reserved` forever after its last reservation ended | `releaseEndedReservations()` on catalogue reads plus a 60s sweep (`EQUIPMENT_STATUS_SWEEP_INTERVAL_MS`) | `tests/bugfixes.equipment.test.js` |
| BUG-4 | Equipment could be reserved for a window that had already ended | **422** for windows that have already ended | same |
| BUG-5 | Reservations on items later put in repair/unavailable still counted towards readiness | They no longer count (`outOfServiceQuantity` is reported), readiness reverts, and the coordinator gets an `equipment_out_of_service` notification | same |
| BUG-6 | Lowering units in service below what's already reserved over-committed the item | **409** when the new value is below the peak concurrent reserved quantity | same |
| BUG-7 | A request accepted by Venue Staff never became an Event | Both approval paths create the Event | same |

### 7. Run the tests

To test SCRUM-21, SCRUM-22 and SCRUM-24, check separately uploaded scrumtestguide.md file. It has the automated commands per story and step-by-step manual test cases with expected results. (As far as I am aware) If there's anything that might need reviewing, DM me back on tele or reply to the uploaded message and I'll see what I can do to remedy it.

```bash
npm test
```

The integration suites need the database from step 4. `npm run db:init` must have been run
since the last pull so new tables exist.

### Troubleshooting

| Problem | Fix |
|---|---|
| `Unable to connect to the database` on startup | Check PostgreSQL is running and `.env` DB credentials are correct |
| `relation "roles" does not exist` | Run `npm run db:init` before `npm run db:seed` |
| `401 Unauthorized` on every request | Make sure you're sending `Authorization: Bearer <accessToken>` — access tokens expire after 15 min by default; use `/api/auth/refresh` to get a new one |
| bcrypt fails to install | Ensure build tools are present (`build-essential`/Xcode CLI tools) since it compiles a native module |
