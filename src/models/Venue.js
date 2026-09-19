const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class Venue extends Model {}

Venue.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    name: { type: DataTypes.STRING(200), allowNull: false },
    location: { type: DataTypes.STRING(255), allowNull: false },
    capacity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
    venueType: {
      type: DataTypes.STRING(50),
      field: 'venue_type',
    },
    supportedLayouts: {
      type: DataTypes.JSONB,
      defaultValue: [],
      field: 'supported_layouts',
    },
    facilities: { type: DataTypes.JSONB, defaultValue: [] },
    accessibilityFeatures: {
      type: DataTypes.JSONB,
      defaultValue: [],
      field: 'accessibility_features',
    },
    operatingHoursStart: {
      type: DataTypes.TIME,
      defaultValue: '08:00',
      field: 'operating_hours_start',
    },
    operatingHoursEnd: {
      type: DataTypes.TIME,
      defaultValue: '22:00',
      field: 'operating_hours_end',
    },
    setupMinutes: { type: DataTypes.INTEGER, defaultValue: 30, field: 'setup_minutes' },
    teardownMinutes: { type: DataTypes.INTEGER, defaultValue: 30, field: 'teardown_minutes' },
    status: {
      type: DataTypes.ENUM('available', 'maintenance', 'blocked'),
      defaultValue: 'available',
    },
  },
  {
    sequelize,
    modelName: 'Venue',
    tableName: 'venues',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Venue;
