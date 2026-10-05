const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// A tentative hold on a venue. Only blocks the venue while active — see
// isHoldActive() in utils/venueConflicts.js for the exact rule.
class VenueHold extends Model {}

VenueHold.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    venueId: { type: DataTypes.UUID, allowNull: false, field: 'venue_id' },
    eventId: { type: DataTypes.UUID, field: 'event_id' },
    heldBy: { type: DataTypes.UUID, field: 'held_by' },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    expiresAt: { type: DataTypes.DATE, field: 'expires_at' },
    status: {
      type: DataTypes.ENUM('active', 'released', 'converted'),
      defaultValue: 'active',
    },
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

module.exports = VenueHold;
