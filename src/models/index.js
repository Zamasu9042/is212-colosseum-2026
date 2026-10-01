const sequelize = require('../config/db');
const { Role, ROLE_NAMES } = require('./Role');
const ClientOrganisation = require('./ClientOrganisation');
const User = require('./User');
const RefreshToken = require('./RefreshToken');
const Venue = require('./Venue');
const Equipment = require('./Equipment');
const EventRequest = require('./EventRequest');
const Event = require('./Event');
const EventProgramme = require('./EventProgramme');
const AgendaItem = require('./AgendaItem');

// --- Associations ---

// Role <-> User
Role.hasMany(User, { foreignKey: 'roleId' });
User.belongsTo(Role, { foreignKey: 'roleId' });

// ClientOrganisation <-> User (Event Organisers belong to an org)
ClientOrganisation.hasMany(User, { foreignKey: 'organisationId' });
User.belongsTo(ClientOrganisation, { foreignKey: 'organisationId' });

// User <-> RefreshToken
User.hasMany(RefreshToken, { foreignKey: 'userId', onDelete: 'CASCADE' });
RefreshToken.belongsTo(User, { foreignKey: 'userId' });

// User (organiser) <-> EventRequest
User.hasMany(EventRequest, { foreignKey: 'organiserId', as: 'submittedRequests' });
EventRequest.belongsTo(User, { foreignKey: 'organiserId', as: 'organiser' });

// ClientOrganisation <-> EventRequest
ClientOrganisation.hasMany(EventRequest, { foreignKey: 'organisationId' });
EventRequest.belongsTo(ClientOrganisation, { foreignKey: 'organisationId' });

// EventRequest <-> Event (1:1)
EventRequest.hasOne(Event, { foreignKey: 'eventRequestId' });
Event.belongsTo(EventRequest, { foreignKey: 'eventRequestId' });

// User (coordinator) <-> Event
User.hasMany(Event, { foreignKey: 'coordinatorId', as: 'coordinatedEvents' });
Event.belongsTo(User, { foreignKey: 'coordinatorId', as: 'coordinator' });

// Venue <-> Event
Venue.hasMany(Event, { foreignKey: 'venueId' });
Event.belongsTo(Venue, { foreignKey: 'venueId' });

// Event <-> EventProgramme (1:1)
Event.hasOne(EventProgramme, { foreignKey: 'eventId', onDelete: 'CASCADE' });
EventProgramme.belongsTo(Event, { foreignKey: 'eventId' });

// EventProgramme <-> AgendaItem (1:many)
EventProgramme.hasMany(AgendaItem, {
  foreignKey: 'programmeId',
  as: 'agendaItems',
  onDelete: 'CASCADE',
});
AgendaItem.belongsTo(EventProgramme, { foreignKey: 'programmeId' });

module.exports = {
  sequelize,
  Role,
  ROLE_NAMES,
  ClientOrganisation,
  User,
  RefreshToken,
  Venue,
  Equipment,
  EventRequest,
  Event,
  EventProgramme,
  AgendaItem,
};