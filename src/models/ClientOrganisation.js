const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class ClientOrganisation extends Model {}

ClientOrganisation.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    name: { type: DataTypes.STRING(200), allowNull: false },
    contactEmail: { type: DataTypes.STRING(255) },
    contactPhone: { type: DataTypes.STRING(30) },
    address: { type: DataTypes.TEXT },
  },
  {
    sequelize,
    modelName: 'ClientOrganisation',
    tableName: 'client_organisations',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = ClientOrganisation;
