const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

// The 5 canonical roles referenced throughout the customer briefing.
// Keep these constants in sync with scripts/seed-roles.js
const ROLE_NAMES = {
  EVENT_ORGANISER: 'event_organiser',
  EVENT_COORDINATOR: 'event_coordinator',
  VENUE_STAFF: 'venue_staff',
  TECHNICAL_SUPPORT_STAFF: 'technical_support_staff',
  ATTENDEE: 'attendee',
};

class Role extends Model {}

Role.init(
  {
    id: { type: DataTypes.SMALLINT, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    displayName: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.TEXT },
  },
  { sequelize, modelName: 'Role', tableName: 'roles', createdAt: 'created_at', updatedAt: false }
);

module.exports = { Role, ROLE_NAMES };
