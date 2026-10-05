const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class EventProgramme extends Model {}

EventProgramme.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'event_id' },
    status: {
      type: DataTypes.ENUM('draft', 'published'),
      defaultValue: 'draft',
    },
    publishedAt: { type: DataTypes.DATE, field: 'published_at' },
  },
  {
    sequelize,
    modelName: 'EventProgramme',
    tableName: 'event_programmes',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EventProgramme;