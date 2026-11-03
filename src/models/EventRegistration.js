const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class EventRegistration extends Model {}

EventRegistration.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    attendeeId: { type: DataTypes.UUID, allowNull: false, field: 'attendee_id' },
    status: {
      type: DataTypes.ENUM('confirmed', 'awaiting_reconfirmation', 'withdrawn'),
      allowNull: false,
      defaultValue: 'confirmed',
    },
    confirmedAt: { type: DataTypes.DATE, allowNull: false, field: 'confirmed_at' },
    withdrawnAt: { type: DataTypes.DATE, field: 'withdrawn_at' },
  },
  {
    sequelize,
    modelName: 'EventRegistration',
    tableName: 'event_registrations',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EventRegistration;
