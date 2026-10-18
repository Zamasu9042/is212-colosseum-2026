-- =====================================================================
-- ConnectSphere Event Planning & Venue Booking System
-- Task 1: Database Schema Initialisation
--
-- Covers: Users, Roles, Events, EventRequests, Venues, Equipment
-- (plus minimal supporting tables needed for referential integrity:
--  client_organisations, refresh_tokens)
--
-- Design notes (per Week 1 Customer Briefing & Week 4 Core Features):
-- - 5 roles: event_organiser, event_coordinator, venue_staff,
--   technical_support_staff, attendee.
-- - An EventRequest is what an Event Organiser drafts/submits. Once a
--   Coordinator is assigned and the request is approved, an Event row
--   is created to track downstream planning (venue/equipment/status).
--   This keeps "draft/submitted/under review" concerns (EventRequest)
--   separate from "planning/confirmed/completed" concerns (Event),
--   matching the distinct statuses described in the briefing.
-- - event_name, preferred_start, preferred_end, and expected_attendance
--   are intentionally NOT marked NOT NULL: an Event Organiser must be
--   able to save an incomplete request as a draft (Sprint 1 — "Save
--   Event Request as Draft"). These fields are only required once a
--   request is actually submitted, which is enforced at the
--   application layer, not by the schema.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- ROLES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id              SMALLSERIAL PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE, -- e.g. 'event_organiser'
    display_name    VARCHAR(100) NOT NULL,       -- e.g. 'Event Organiser'
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- CLIENT ORGANISATIONS (external orgs that Event Organisers belong to)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_organisations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(200) NOT NULL,
    contact_email   VARCHAR(255),
    contact_phone   VARCHAR(30),
    address         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- USERS
-- Single table for all 5 roles; role-specific optional fields kept
-- nullable (e.g. department is only meaningful for internal staff).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email               VARCHAR(255) NOT NULL UNIQUE,
    password_hash       VARCHAR(255) NOT NULL,
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    phone               VARCHAR(30),
    role_id             SMALLINT NOT NULL REFERENCES roles(id),
    organisation_id     UUID REFERENCES client_organisations(id), -- Event Organisers only
    organisation        VARCHAR(200), -- attendee-provided organisation name
    department          VARCHAR(100), -- internal staff only
    communication_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_organisation_id ON users(organisation_id);

-- ---------------------------------------------------------------------
-- REFRESH TOKENS (for session/token management & revocation)
-- Only a hash of the refresh token is stored, never the raw token.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------
-- VENUES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venues (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    VARCHAR(200) NOT NULL,
    location                VARCHAR(255) NOT NULL,
    capacity                INTEGER NOT NULL CHECK (capacity > 0),
    venue_type              VARCHAR(50), -- e.g. "ballroom","conference_room","auditorium","meeting_room","outdoor_space"
    supported_layouts       JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["classroom","theatre"]
    facilities              JSONB NOT NULL DEFAULT '[]'::jsonb,
    accessibility_features  JSONB NOT NULL DEFAULT '[]'::jsonb,
    operating_hours_start   TIME NOT NULL DEFAULT '08:00',
    operating_hours_end     TIME NOT NULL DEFAULT '22:00',
    setup_minutes           INTEGER NOT NULL DEFAULT 30,   -- prep time needed before an event
    teardown_minutes        INTEGER NOT NULL DEFAULT 30,   -- turnaround time needed after
    status                  VARCHAR(20) NOT NULL DEFAULT 'available'
                                CHECK (status IN ('available','maintenance','blocked')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added alongside Venue Searching and Filtering: ADD COLUMN IF NOT EXISTS
-- keeps this idempotent for databases that already ran an earlier version
-- of this script (matches the CREATE TABLE IF NOT EXISTS pattern above).
ALTER TABLE venues ADD COLUMN IF NOT EXISTS venue_type VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organisation VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_venues_venue_type ON venues(venue_type);
CREATE INDEX IF NOT EXISTS idx_venues_capacity ON venues(capacity);
CREATE INDEX IF NOT EXISTS idx_venues_facilities ON venues USING GIN (facilities);

-- ---------------------------------------------------------------------
-- EQUIPMENT
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS equipment (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    type                VARCHAR(100) NOT NULL, -- e.g. 'AV', 'furniture', 'networking'
    description         TEXT,
    quantity_total      INTEGER NOT NULL CHECK (quantity_total >= 0),
    quantity_available  INTEGER NOT NULL CHECK (quantity_available >= 0),
    location            VARCHAR(255),
    status              VARCHAR(20) NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available','maintenance','damaged')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (quantity_available <= quantity_total)
);

-- ---------------------------------------------------------------------
-- EVENT REQUESTS
-- Created by an Event Organiser; tracks the request lifecycle up to
-- the initial approval decision.
--
-- event_name, preferred_start, preferred_end, and expected_attendance
-- are nullable so a draft can be saved incomplete (see file header
-- note). Their CHECK constraints below still apply IF a value is
-- present, but pass automatically when the value is null, since a
-- comparison against NULL in Postgres evaluates to NULL and is
-- treated as satisfying the CHECK.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_requests (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organiser_id                UUID NOT NULL REFERENCES users(id),
    organisation_id             UUID REFERENCES client_organisations(id),
    event_name                  VARCHAR(200),
    description                 TEXT,
    purpose                     TEXT,
    category                    VARCHAR(50), -- conference, workshop, training, exhibition, etc.
    preferred_start             TIMESTAMPTZ,
    preferred_end                TIMESTAMPTZ,
    expected_attendance         INTEGER CHECK (expected_attendance > 0),
    venue_requirements          TEXT,
    requested_layout            VARCHAR(100), -- theatre, classroom, banquet, etc.
    accessibility_requirements  TEXT,
    facility_requirements       TEXT,
    setup_requirements          TEXT,
    equipment_requirements      TEXT,
    layout                      TEXT,
    registration_setup          TEXT,
    registration_required       BOOLEAN NOT NULL DEFAULT false,
    status                      VARCHAR(20) NOT NULL DEFAULT 'draft'
                                    CHECK (status IN
                                        ('draft','submitted','under_review','approved','rejected','returned')),
    submitted_at                TIMESTAMPTZ,
    assigned_coordinator_id     UUID REFERENCES users(id),
    review_reason               TEXT,
    reviewed_at                 TIMESTAMPTZ,
    reviewed_by                 UUID REFERENCES users(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (preferred_end IS NULL OR preferred_start IS NULL OR preferred_end > preferred_start)
);
CREATE INDEX IF NOT EXISTS idx_event_requests_organiser_id ON event_requests(organiser_id);
CREATE INDEX IF NOT EXISTS idx_event_requests_status ON event_requests(status);

-- Added alongside "Submit Event Request with Mandatory Fields". These are
-- idempotent so existing dev/test databases can be brought forward without a
-- full reset.
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS layout TEXT;
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS registration_setup TEXT;
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS assigned_coordinator_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_event_requests_assigned_coordinator_id ON event_requests(assigned_coordinator_id);
-- Keep existing development databases compatible when this feature is added
-- after the original event_requests table was created.
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS requested_layout VARCHAR(100);
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS facility_requirements TEXT;
ALTER TABLE event_requests ADD COLUMN IF NOT EXISTS setup_requirements TEXT;

-- ---------------------------------------------------------------------
-- EVENTS
-- Created once an EventRequest is approved and a Coordinator assigned.
-- Tracks the operational planning lifecycle.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_request_id    UUID NOT NULL UNIQUE REFERENCES event_requests(id),
    coordinator_id      UUID REFERENCES users(id),
    venue_id            UUID REFERENCES venues(id),
    start_datetime      TIMESTAMPTZ NOT NULL,
    end_datetime        TIMESTAMPTZ NOT NULL,
    status              VARCHAR(30) NOT NULL DEFAULT 'planning'
                            CHECK (status IN
                                ('planning','awaiting_arrangements','confirmed','completed','cancelled')),
    confirmed_at         TIMESTAMPTZ,
    cancelled_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_datetime > start_datetime)
);
CREATE INDEX IF NOT EXISTS idx_events_coordinator_id ON events(coordinator_id);
CREATE INDEX IF NOT EXISTS idx_events_venue_id ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- ---------------------------------------------------------------------
-- EVENT PROGRAMMES & AGENDA ITEMS
-- An Event Coordinator builds a programme (the schedule) for a
-- confirmed Event, made up of ordered agenda items. A programme starts
-- as a draft the Coordinator can keep editing, then is explicitly
-- published so Attendees can see it.
--
-- One programme per Event (enforced by the UNIQUE on event_id).
-- sort_order is an explicit integer the Coordinator controls directly
-- via the reorder endpoint, rather than being inferred from start_time
-- — this keeps "reorder" and "reschedule" as distinct actions, and
-- still lets the published view simply sort by start_time for display
-- (chronological order), independent of how items were authored.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_programmes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published')),
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agenda_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    programme_id    UUID NOT NULL REFERENCES event_programmes(id) ON DELETE CASCADE,
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    speaker         VARCHAR(200),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    -- Explicit per-item override for the "prevent overlap unless
    -- explicitly permitted" AC: set true to allow this item to overlap
    -- with others (e.g. concurrent breakout sessions).
    allow_overlap   BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_agenda_items_programme_id ON agenda_items(programme_id);
CREATE INDEX IF NOT EXISTS idx_agenda_items_start_time ON agenda_items(start_time);

-- ---------------------------------------------------------------------
-- VENUE UNAVAILABILITY PERIODS
-- Time-bound blocks recorded by Venue Staff (maintenance, renovation,
-- safety issues, internal activities...). Unlike venues.status, which
-- marks a venue out of service indefinitely, these cover a specific
-- window and are considered by venue schedule conflict detection.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_unavailability (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    start_datetime  TIMESTAMPTZ NOT NULL,
    end_datetime    TIMESTAMPTZ NOT NULL,
    reason          VARCHAR(500) NOT NULL,
    -- Category of the reason (Mark Venue Temporarily Unavailable AC2);
    -- `reason` above holds the free-text detail.
    reason_category VARCHAR(30) NOT NULL DEFAULT 'other'
                        CHECK (reason_category IN
                            ('maintenance','equipment_failure','renovation','safety_concern','other')),
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_datetime > start_datetime)
);
CREATE INDEX IF NOT EXISTS idx_venue_unavailability_venue_window
    ON venue_unavailability(venue_id, start_datetime, end_datetime);

-- ---------------------------------------------------------------------
-- VENUE HOLDS (tentative holds)
-- A temporary claim on a venue while an event is still being finalised.
-- A hold only blocks the venue while it is ACTIVE: status = 'active'
-- AND (expires_at IS NULL OR expires_at > now()). An expired hold
-- keeps status 'active' in the table but is ignored by conflict
-- detection, so no background job is needed to expire holds.
-- event_id is optional: a coordinator may hold a slot before the
-- Event row exists.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_holds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    event_id        UUID REFERENCES events(id) ON DELETE SET NULL,
    held_by         UUID REFERENCES users(id),
    start_datetime  TIMESTAMPTZ NOT NULL,
    end_datetime    TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','released','converted')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_datetime > start_datetime)
);
CREATE INDEX IF NOT EXISTS idx_venue_holds_venue_status ON venue_holds(venue_id, status);
CREATE INDEX IF NOT EXISTS idx_venue_holds_event_id ON venue_holds(event_id);

-- ---------------------------------------------------------------------
-- VENUE BOOKINGS
-- One row per venue requested for an event. An event may have many
-- (multi-venue events); every row keeps its own event_id so all of an
-- event's bookings stay linked, and each is approved/rejected/cancelled
-- on its own without touching the others.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venue_bookings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id              UUID NOT NULL REFERENCES events(id),
    venue_id              UUID NOT NULL REFERENCES venues(id),
    requested_by          UUID NOT NULL REFERENCES users(id),
    start_datetime        TIMESTAMPTZ NOT NULL,
    end_datetime          TIMESTAMPTZ NOT NULL,
    expected_attendance   INTEGER NOT NULL CHECK (expected_attendance > 0),
    requirements          TEXT,
    status                VARCHAR(30) NOT NULL DEFAULT 'pending'
                              CHECK (status IN
                                  ('pending','approved','rejected','cancelled','needs_replacement','replaced')),
    review_reason         TEXT,
    reviewed_by           UUID REFERENCES users(id),
    reviewed_at           TIMESTAMPTZ,
    replaces_booking_id   UUID REFERENCES venue_bookings(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_datetime > start_datetime)
);
CREATE INDEX IF NOT EXISTS idx_venue_bookings_event_id ON venue_bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_venue_bookings_venue_id ON venue_bookings(venue_id);
CREATE INDEX IF NOT EXISTS idx_venue_bookings_status ON venue_bookings(status);

-- ---------------------------------------------------------------------
-- NOTIFICATIONS (in-app)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type              VARCHAR(50) NOT NULL,
    message           TEXT NOT NULL,
    event_id          UUID REFERENCES events(id),
    venue_booking_id  UUID REFERENCES venue_bookings(id),
    read_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- ---------------------------------------------------------------------
-- Trigger to auto-maintain updated_at columns
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['client_organisations','users','venues','equipment','event_requests','events','event_programmes','agenda_items','venue_unavailability','venue_holds','venue_bookings']
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;
             CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t
        );
    END LOOP;
END;
$$;