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
        'confirmed',
        'completed',
        'cancelled'
      ),
      defaultValue: 'planning',
    },
    confirmedAt: { type: DataTypes.DATE, field: 'confirmed_at' },
    cancelledAt: { type: DataTypes.DATE, field: 'cancelled_at' },
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
