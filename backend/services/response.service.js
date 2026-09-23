/**
 * Standardized API response shapes.
 * All endpoints should return one of these formats.
 */

/**
 * Success response
 */
function successResponse(data, meta = {}) {
  return {
    success: true,
    data,
    ...meta
  };
}

/**
 * Error response
 */
function errorResponse(message, code = null, statusCode = 500) {
  const response = {
    success: false,
    error: message
  };
  if (code) {
    response.code = code;
  }
  return { response, statusCode };
}

/**
 * Wrap an async route handler to standardize errors and responses
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  successResponse,
  errorResponse,
  asyncHandler
};
