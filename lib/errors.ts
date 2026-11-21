/**
 * GEODATA HUB — typed application errors.
 * Services throw AppError; the API layer (M3) maps these to the uniform
 * error envelope with the correct HTTP status.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  unauthenticated: () =>
    new AppError("UNAUTHENTICATED", 401, "Authentication required"),
  forbidden: (message?: string) =>
    new AppError(
      "FORBIDDEN",
      403,
      message ?? "You do not have permission to perform this action",
    ),
  notFound: (entity: string) =>
    new AppError("NOT_FOUND", 404, `${entity} not found`),
  conflict: (message: string) => new AppError("CONFLICT", 409, message),
  validation: (message: string, details?: unknown) =>
    new AppError("VALIDATION_ERROR", 400, message, details),
};
