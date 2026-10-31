require('dotenv').config();
const { Sequelize } = require('sequelize');
const { connectionConfig } = require('./databaseConfig');

const config = connectionConfig();

const sequelize = new Sequelize(
  config.database,
  config.user,
  config.password,
  {
    host: config.host,
    port: config.port,
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    define: {
      underscored: true, // maps camelCase model attrs -> snake_case columns
      timestamps: true,
    },
  }
);

module.exports = sequelize;
