// Postgres error codes that mean the CLIENT sent bad data (a value that
// violates a CHECK/NOT NULL/foreign-key constraint, or is malformed for
// its column type) rather than something going wrong on the server.
// Sequelize's own validators (e.g. on an ENUM field) don't catch every
// case — an unrecognised enum value, for instance, can sail straight
// through to Postgres and only get rejected there, arriving here as a
// generic SequelizeDatabaseError. Without this mapping that became an
// unhandled 500 for what is really a 400.
const CLIENT_CAUSED_PG_ERROR_CODES = new Set([
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23514', // check_violation (e.g. an invalid ENUM/status value)
  '22P02', // invalid_text_representation (e.g. a malformed UUID)
  '22007', // invalid_datetime_format
  '22003', // numeric_value_out_of_range
]);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isExpectedClientError =
    (err.status >= 400 && err.status < 500) ||
    err.name === 'SequelizeValidationError' ||
    err.name === 'SequelizeUniqueConstraintError' ||
    err.name === 'SequelizeForeignKeyConstraintError' ||
    (err.name === 'SequelizeDatabaseError' && CLIENT_CAUSED_PG_ERROR_CODES.has(err.parent?.code));

  if (isExpectedClientError) {
    process.stderr.write(`[${req.method} ${req.originalUrl}] ${err.name}: ${err.message}\n`);
  } else {
    console.error(`[${req.method} ${req.originalUrl}] Unexpected error:`, err);
  }

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({
      error: 'Validation failed.',
      details: err.errors?.map((e) => e.message) || [err.message],
    });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({
      error: 'Validation failed.',
      details: ['One or more referenced records do not exist.'],
    });
  }

  if (
    err.name === 'SequelizeDatabaseError' &&
    CLIENT_CAUSED_PG_ERROR_CODES.has(err.parent?.code)
  ) {
    // Deliberately generic to the client — the full Postgres error
    // (already logged above) can include raw row values, which we don't
    // want to echo back in an API response.
    return res.status(400).json({
      error: 'Validation failed.',
      details: ['One or more fields contain an invalid value.'],
    });
  }

  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error.' : err.message;
  res.status(status).json({ error: message });
}

module.exports = { errorHandler };
