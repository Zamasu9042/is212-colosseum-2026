const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

const BOOKING_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'needs_replacement',
  'replaced',
];

class VenueBooking extends Model {}

VenueBooking.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    venueId: { type: DataTypes.UUID, allowNull: false, field: 'venue_id' },
    requestedBy: { type: DataTypes.UUID, allowNull: false, field: 'requested_by' },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    expectedAttendance: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
      field: 'expected_attendance',
    },
    requirements: { type: DataTypes.TEXT },
    status: { type: DataTypes.ENUM(...BOOKING_STATUSES), defaultValue: 'pending' },
    reviewReason: { type: DataTypes.TEXT, field: 'review_reason' },
    reviewedBy: { type: DataTypes.UUID, field: 'reviewed_by' },
    reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
    replacesBookingId: { type: DataTypes.UUID, field: 'replaces_booking_id' },
    // Set by the conflict audit when the booking clashes under the updated
    // (Week 7) rules. The booking itself is preserved untouched.
    conflictFlaggedAt: { type: DataTypes.DATE, field: 'conflict_flagged_at' },
    conflictDetails: { type: DataTypes.JSONB, field: 'conflict_details' },
  },
  {
    sequelize,
    modelName: 'VenueBooking',
    tableName: 'venue_bookings',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

VenueBooking.STATUSES = BOOKING_STATUSES;

module.exports = VenueBooking;