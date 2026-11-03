const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class Event extends Model {}

Event.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventRequestId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      field: 'event_request_id',
    },
    coordinatorId: { type: DataTypes.UUID, field: 'coordinator_id' },
    venueId: { type: DataTypes.UUID, field: 'venue_id' },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    status: {
      type: DataTypes.ENUM(
        'planning',
        'awaiting_arrangements',
        'awaiting_safety_approval',
        'confirmed',
        'preparation',
        'completed',
        'cancelled'
      ),
      defaultValue: 'planning',
    },
    confirmedAt: { type: DataTypes.DATE, field: 'confirmed_at' },
    cancelledAt: { type: DataTypes.DATE, field: 'cancelled_at' },
    registrationCapacity: {
      type: DataTypes.INTEGER,
      validate: { min: 1 },
      field: 'registration_capacity',
    },
    availableCapacity: {
      type: DataTypes.INTEGER,
      validate: { min: 0 },
      field: 'available_capacity',
    },
    // Set by the venue conflict audit when this event's direct venue
    // (venueId) clashes under the updated rules. Nothing else is changed.
    venueConflictFlaggedAt: { type: DataTypes.DATE, field: 'venue_conflict_flagged_at' },
    venueConflictDetails: { type: DataTypes.JSONB, field: 'venue_conflict_details' },
    // SCRUM-24: only 'complete' once every equipment request is fully allocated.
    technicalReadiness: {
      type: DataTypes.STRING(20),
      defaultValue: 'pending',
      field: 'technical_readiness',
      validate: { isIn: [['pending', 'complete']] },
    },
    technicalReadinessAt: { type: DataTypes.DATE, field: 'technical_readiness_at' },
    technicalReadinessBy: { type: DataTypes.UUID, field: 'technical_readiness_by' },
    // Set when a MAJOR change (date/time, attendance, venue or equipment
    // requirements) is applied, so venue/equipment arrangements get
    // re-checked. Cleared by staff once reassessed.
    reassessmentFlaggedAt: { type: DataTypes.DATE, field: 'reassessment_flagged_at' },
    reassessmentDetails: { type: DataTypes.JSONB, field: 'reassessment_details' },
  },
  {
    sequelize,
    modelName: 'Event',
    tableName: 'events',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Event;