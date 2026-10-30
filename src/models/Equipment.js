const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class Equipment extends Model {}

Equipment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    name: { type: DataTypes.STRING(200), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.TEXT },
    quantityTotal: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 0 },
      field: 'quantity_total',
    },
    quantityAvailable: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 0 },
      field: 'quantity_available',
    },
    location: { type: DataTypes.STRING(255) },
    // SCRUM-22. 'reserved' is system-managed by the reservation service;
    // see EQUIPMENT_STATUSES in src/utils/equipmentAvailability.js.
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'available',
      validate: { isIn: [['available', 'reserved', 'in_repair', 'unavailable']] },
    },
  },
  {
    sequelize,
    modelName: 'Equipment',
    tableName: 'equipment',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Equipment;
