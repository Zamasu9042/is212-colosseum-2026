const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// SCRUM-21: commits `quantity` units of one catalogue item to one event for
// [startDatetime, endDatetime). Cancelling keeps the row (status
// 'cancelled') so there is a record of who released it and when.
class EquipmentReservation extends Model {}

EquipmentReservation.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
    equipmentId: { type: DataTypes.UUID, allowNull: false, field: 'equipment_id' },
    equipmentRequestId: { type: DataTypes.UUID, field: 'equipment_request_id' },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    startDatetime: { type: DataTypes.DATE, allowNull: false, field: 'start_datetime' },
    endDatetime: { type: DataTypes.DATE, allowNull: false, field: 'end_datetime' },
    organiserName: { type: DataTypes.STRING(201), field: 'organiser_name' },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'active',
      validate: { isIn: [['active', 'cancelled']] },
    },
    reservedBy: { type: DataTypes.UUID, field: 'reserved_by' },
    reservedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'reserved_at' },
    cancelledBy: { type: DataTypes.UUID, field: 'cancelled_by' },
    cancelledAt: { type: DataTypes.DATE, field: 'cancelled_at' },
    cancellationReason: { type: DataTypes.TEXT, field: 'cancellation_reason' },
  },
  {
    sequelize,
    modelName: 'EquipmentReservation',
    tableName: 'equipment_reservations',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = EquipmentReservation;
