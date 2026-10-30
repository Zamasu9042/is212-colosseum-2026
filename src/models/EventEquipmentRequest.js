const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// SCRUM-24: one line of an event's equipment needs ("3 x Projector").
// Allocation = sum of active reservations linked to this line.
class EventEquipmentRequest extends Model {}

EventEquipmentRequest.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    equipmentType: { type: DataTypes.STRING(100), allowNull: false, field: 'equipment_type' },
    equipmentId: { type: DataTypes.UUID, field: 'equipment_id' },
    quantityRequested: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
      field: 'quantity_requested',
    },
    technicalRequirements: { type: DataTypes.TEXT, field: 'technical_requirements' },
    requestedBy: { type: DataTypes.UUID, field: 'requested_by' },
  },
  {
    sequelize,
    modelName: 'EventEquipmentRequest',
    tableName: 'event_equipment_requests',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EventEquipmentRequest;
