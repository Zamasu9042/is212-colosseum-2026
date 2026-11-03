const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class Notification extends Model {}

Notification.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    type: { type: DataTypes.STRING(50), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false },
    eventId: { type: DataTypes.UUID, field: 'event_id' },
    venueBookingId: { type: DataTypes.UUID, field: 'venue_booking_id' },
    venueHoldId: { type: DataTypes.UUID, field: 'venue_hold_id' },
    // Machine-readable detail/actions for clients.  The message remains a
    // complete plain-text fallback for older notification consumers.
    metadata: { type: DataTypes.JSONB },
    readAt: { type: DataTypes.DATE, field: 'read_at' },
  },
  {
    sequelize,
    modelName: 'Notification',
    tableName: 'notifications',
    createdAt: 'created_at',
    updatedAt: false,
  }
);

module.exports = Notification;
