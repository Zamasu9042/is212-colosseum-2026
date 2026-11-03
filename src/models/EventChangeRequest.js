const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// An Event Organiser's request to change a submitted/approved event. It
// changes nothing until the assigned Event Coordinator approves it.
class EventChangeRequest extends Model {}

EventChangeRequest.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    requestedBy: { type: DataTypes.UUID, allowNull: false, field: 'requested_by' },
    // The values the organiser wants, e.g. { startDatetime, expectedAttendance }.
    proposedChanges: { type: DataTypes.JSONB, allowNull: false, field: 'proposed_changes' },
    // What those fields were at the time of the request (for the reviewer's diff).
    currentValues: { type: DataTypes.JSONB, allowNull: false, field: 'current_values' },
    reason: { type: DataTypes.TEXT },
    isMajor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_major' },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'withdrawn'),
      allowNull: false,
      defaultValue: 'pending',
    },
    reviewedBy: { type: DataTypes.UUID, field: 'reviewed_by' },
    reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
    reviewReason: { type: DataTypes.TEXT, field: 'review_reason' },
  },
  {
    sequelize,
    modelName: 'EventChangeRequest',
    tableName: 'event_change_requests',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EventChangeRequest;