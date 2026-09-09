require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const apiRoutes = require('./routes');
const { authenticate } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Public health check — does NOT require authentication.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// --- Account Enforcement -------------------------------------------
// `authenticate` is applied globally to every /api/* route. It only
// lets a request through without a valid token if the route is on the
// explicit PUBLIC_ROUTES allow-list (register/login/refresh). Every
// other endpoint blocks unauthenticated ("guest") access by default.
app.use('/api', authenticate, apiRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use(errorHandler);

module.exports = app;
