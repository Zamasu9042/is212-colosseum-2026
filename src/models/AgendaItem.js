const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class AgendaItem extends Model {}

AgendaItem.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    programmeId: { type: DataTypes.UUID, allowNull: false, field: 'programme_id' },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT },
    startTime: { type: DataTypes.DATE, allowNull: false, field: 'start_time' },
    endTime: { type: DataTypes.DATE, allowNull: false, field: 'end_time' },
    speaker: { type: DataTypes.STRING(200) },
    sortOrder: { type: DataTypes.INTEGER, defaultValue: 0, field: 'sort_order' },
    // Explicit override: when true, this item is allowed to overlap in
    // time with other agenda items (e.g. concurrent breakout sessions).
    allowOverlap: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'allow_overlap' },
  },
  {
    sequelize,
    modelName: 'AgendaItem',
    tableName: 'agenda_items',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = AgendaItem;