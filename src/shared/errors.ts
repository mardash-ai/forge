// Forge errors are part of the API contract. A good error tells a human what
// happened and how to fix it, and tells an agent whether to retry or change
// input. See 05_FORGE_API_PHILOSOPHY.md.

export type Retryable = 'retry' | 'change-input' | 'needs-human' | 'no';

export class ForgeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retry: Retryable;
  readonly details?: unknown;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    retry?: Retryable;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'ForgeError';
    this.code = opts.code;
    this.status = opts.status ?? 400;
    this.retry = opts.retry ?? 'change-input';
    this.details = opts.details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retry: this.retry,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (message: string, details?: unknown) =>
  new ForgeError({ code: 'not_found', message, status: 404, retry: 'change-input', details });

export const invalidInput = (message: string, details?: unknown) =>
  new ForgeError({ code: 'invalid_input', message, status: 422, retry: 'change-input', details });

export const policyBlocked = (message: string, details?: unknown) =>
  new ForgeError({ code: 'policy_blocked', message, status: 403, retry: 'needs-human', details });

export const permissionDenied = (message: string, details?: unknown) =>
  new ForgeError({ code: 'permission_denied', message, status: 403, retry: 'needs-human', details });

export const dependencyUnavailable = (message: string, details?: unknown) =>
  new ForgeError({ code: 'dependency_unavailable', message, status: 503, retry: 'needs-human', details });
