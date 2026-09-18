const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class EventRequest extends Model {}

EventRequest.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    organiserId: { type: DataTypes.UUID, allowNull: false, field: 'organiser_id' },
    organisationId: { type: DataTypes.UUID, field: 'organisation_id' },


    eventName: { type: DataTypes.STRING(200), field: 'event_name' },
    preferredStart: { type: DataTypes.DATE, field: 'preferred_start' },
    preferredEnd: { type: DataTypes.DATE, field: 'preferred_end' },
    expectedAttendance: {
      type: DataTypes.INTEGER,
      validate: { min: 1 }, // still enforced if a value is provided; null is fine
      field: 'expected_attendance',
    },

    description: { type: DataTypes.TEXT },
    purpose: { type: DataTypes.TEXT },
    category: { type: DataTypes.STRING(50) },
    venueRequirements: { type: DataTypes.TEXT, field: 'venue_requirements' },
    accessibilityRequirements: { type: DataTypes.TEXT, field: 'accessibility_requirements' },
    equipmentRequirements: { type: DataTypes.TEXT, field: 'equipment_requirements' },
    registrationRequired: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'registration_required',
    },
    status: {
      type: DataTypes.ENUM('draft', 'submitted', 'under_review', 'approved', 'rejected', 'returned'),
      defaultValue: 'draft',
    },
    submittedAt: { type: DataTypes.DATE, field: 'submitted_at' },
    reviewReason: { type: DataTypes.TEXT, field: 'review_reason' },
    reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
    reviewedBy: { type: DataTypes.UUID, field: 'reviewed_by' },
  },
  {
    sequelize,
    modelName: 'EventRequest',
    tableName: 'event_requests',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EventRequest;