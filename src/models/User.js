const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class User extends Model {
  /** Never expose the password hash to API responses. */
  toSafeJSON() {
    const { passwordHash, ...safe } = this.toJSON();
    return safe;
  }
}

User.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
    },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    firstName: { type: DataTypes.STRING(100), allowNull: false, field: 'first_name' },
    lastName: { type: DataTypes.STRING(100), allowNull: false, field: 'last_name' },
    phone: { type: DataTypes.STRING(30) },
    roleId: { type: DataTypes.SMALLINT, allowNull: false, field: 'role_id' },
    organisationId: { type: DataTypes.UUID, field: 'organisation_id' },
    organization: { type: DataTypes.STRING(200), field: 'organisation' },
    department: { type: DataTypes.STRING(100) },
    communicationPrefs: {
      type: DataTypes.JSONB,
      defaultValue: {},
      field: 'communication_prefs',
    },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = User;
