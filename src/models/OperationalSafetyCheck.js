const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class OperationalSafetyCheck extends Model {}

OperationalSafetyCheck.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'event_id' },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'changes_requested', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    technicalArrangementsConfirmed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'technical_arrangements_confirmed',
    },
    emergencyAccess: { type: DataTypes.TEXT, allowNull: false, field: 'emergency_access' },
    equipmentPlacement: { type: DataTypes.TEXT, allowNull: false, field: 'equipment_placement' },
    crowdMovement: { type: DataTypes.TEXT, allowNull: false, field: 'crowd_movement' },
    venueRestrictions: { type: DataTypes.TEXT, field: 'venue_restrictions' },
    requestedBy: { type: DataTypes.UUID, allowNull: false, field: 'requested_by' },
    requestedAt: { type: DataTypes.DATE, allowNull: false, field: 'requested_at' },
    reviewedBy: { type: DataTypes.UUID, field: 'reviewed_by' },
    reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
    decisionReason: { type: DataTypes.TEXT, field: 'decision_reason' },
  },
  {
    sequelize,
    modelName: 'OperationalSafetyCheck',
    tableName: 'operational_safety_checks',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = OperationalSafetyCheck;
