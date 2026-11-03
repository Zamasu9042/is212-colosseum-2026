const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// Permanent record of every change applied to an event's information
// during planning: who, when, what (old and new value per field) and
// whether it was a major or ordinary change. Rows are never edited.
class EventChangeLog extends Model {}

EventChangeLog.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    changedBy: { type: DataTypes.UUID, field: 'changed_by' },
    changeType: {
      type: DataTypes.ENUM('major', 'ordinary'),
      allowNull: false,
      field: 'change_type',
    },
    source: {
      type: DataTypes.ENUM('coordinator_update', 'change_request'),
      allowNull: false,
    },
    // { fieldName: { from, to } }
    changes: { type: DataTypes.JSONB, allowNull: false },
    reason: { type: DataTypes.TEXT },
    changeRequestId: { type: DataTypes.UUID, field: 'change_request_id' },
  },
  {
    sequelize,
    modelName: 'EventChangeLog',
    tableName: 'event_change_log',
    createdAt: 'created_at',
    updatedAt: false,
  }
);

module.exports = EventChangeLog;