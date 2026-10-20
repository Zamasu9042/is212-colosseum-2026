const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// A tentative hold on a venue. Only blocks the venue while active — see
// isHoldActive() in utils/venueConflicts.js for the exact rule.
//
// Every hold has an expiry (Week 7 — Manage Expiring Tentative Venue
// Holds). Once expiresAt passes the hold stops blocking the venue, and the
// expiry sweep (services/holdExpiryService.js) moves it to 'expired'.
// 'expired' is NOT 'converted': an expired hold is never a booking.
const HOLD_STATUSES = ['active', 'released', 'converted', 'expired'];

class VenueHold extends Model {}

VenueHold.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    venueId: { type: DataTypes.UUID, allowNull: false, field: 'venue_id' },
    eventId: { type: DataTypes.UUID, field: 'event_id' },
    heldBy: { type: DataTypes.UUID, field: 'held_by' },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'expires_at',
      validate: { notNull: { msg: 'Every tentative hold must have an expiry date and time.' } },
    },
    status: {
      type: DataTypes.ENUM(...HOLD_STATUSES),
      defaultValue: 'active',
    },
    expiryWarningSentAt: { type: DataTypes.DATE, field: 'expiry_warning_sent_at' },
    expiredAt: { type: DataTypes.DATE, field: 'expired_at' },
    notes: { type: DataTypes.TEXT },
  },
  {
    sequelize,
    modelName: 'VenueHold',
    tableName: 'venue_holds',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

VenueHold.STATUSES = HOLD_STATUSES;

module.exports = VenueHold;
