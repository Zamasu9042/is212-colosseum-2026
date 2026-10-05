const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// A time-bound period during which a venue cannot be booked
// (maintenance, renovation, safety issue, internal activity, ...).
class VenueUnavailability extends Model {}

VenueUnavailability.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    venueId: { type: DataTypes.UUID, allowNull: false, field: 'venue_id' },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    createdBy: { type: DataTypes.UUID, field: 'created_by' },
  },
  {
    sequelize,
    modelName: 'VenueUnavailability',
    tableName: 'venue_unavailability',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = VenueUnavailability;
