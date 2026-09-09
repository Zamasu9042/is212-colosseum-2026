const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/db');

class RefreshToken extends Model {}

RefreshToken.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
    tokenHash: { type: DataTypes.STRING(255), allowNull: false, field: 'token_hash' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    revokedAt: { type: DataTypes.DATE, field: 'revoked_at' },
  },
  {
    sequelize,
    modelName: 'RefreshToken',
    tableName: 'refresh_tokens',
    createdAt: 'created_at',
    updatedAt: false,
  }
);

module.exports = RefreshToken;
