require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');

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

// --- Web GUI --------------------------------------------------------
// The browser interface in /public is a static single-page app that talks
// to the API above. Open http://localhost:<PORT>/ after `npm start`.
// Unknown /api paths still fall through to the JSON 404 below.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api\/|health$).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use(errorHandler);

module.exports = app;
