export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const invalid = (message = 'Invalid request.') =>
  new ApiError(400, 'INVALID_REQUEST', message);
export const missing = () =>
  new ApiError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
