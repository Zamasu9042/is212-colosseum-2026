const attendeeRoutes = require('./routes/attendeeRoutes');
const attendeeController = require('./controllers/attendeeController');
const attendeeValidator = require('./validators/attendeeValidator');
const preferenceService = require('./services/preferenceService');
const registrationRoutes = require('./routes/registrationRoutes');

module.exports = {
  attendeeRoutes,
  attendeeController,
  attendeeValidator,
  preferenceService,
  registrationRoutes,
};
