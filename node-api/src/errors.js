// Errors with a public status/code. app.js turns them into { error: { code, fields } } responses.
class ApiError extends Error {
  constructor(status, code, fields) {
    super(code);
    Object.assign(this, { status, code, fields });
  }
}
module.exports = { ApiError };
