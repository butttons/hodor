/**
 * Shared error envelope: flat `{ code, message, status }` — the feedr convention —
 * surfaced by the global `onError` handler.
 * @module
 */

import { z } from "zod";

/** Machine-readable error codes used across responses. */
export const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * An application error carrying a stable code + status, rendered by the global
 * handler as `{ code, message, status }`.
 */
export class AppHTTPException extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly cause?: unknown;

  constructor(opts: { message: string; code: ErrorCode; status: number; cause?: unknown }) {
    super(opts.message);
    this.name = "AppHTTPException";
    this.code = opts.code;
    this.status = opts.status;
    this.cause = opts.cause;
  }

  toJSON(): { code: ErrorCode; message: string; status: number } {
    return { code: this.code, message: this.message, status: this.status };
  }
}

/**
 * Hook for `zValidator` that turns a zod validation failure into our flat
 * `{ code, message, status }` envelope (thrown, then rendered by `onError`),
 * instead of zValidator's default `{ success:false, error }` body.
 */
export function validationHook(input: { success: boolean; error?: unknown }): undefined {
  if (input.success) return undefined;
  const error = input.error as z.ZodError | undefined;
  const details = error?.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new AppHTTPException({
    code: ErrorCodes.VALIDATION_FAILED,
    message: details ? `Invalid input: ${details}` : "Invalid input",
    status: 400,
  });
}
