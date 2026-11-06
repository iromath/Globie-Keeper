/** An error that is safe to surface to the client. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }

  static unauthorized(message = 'Sign in to continue'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You are not a member of this group'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }
}
