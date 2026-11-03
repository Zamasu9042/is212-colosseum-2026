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
    // Contact details are a snapshot of what the attendee submitted for this
    // event. They deliberately do not track later profile edits.
    fullName: { type: DataTypes.STRING(200), field: 'full_name' },
    workEmail: { type: DataTypes.STRING(255), field: 'work_email', validate: { isEmail: true } },
    contactNumber: { type: DataTypes.STRING(20), field: 'contact_number' },
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
