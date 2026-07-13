import { ForgeError, type Retryable } from '../shared/errors';

// C31 — the membership failure vocabulary. Each code maps to a stable HTTP status + retry hint so a
// consumer can branch on `error.code` (the codes ARE the contract). Thrown by the pure service ops
// (src/membership/service.ts) and serialized by the route's ForgeError handler.
export type MembershipErrorCode =
  | 'not_a_member'
  | 'insufficient_role'
  | 'insufficient_permission'
  | 'already_a_member'
  | 'already_invited'
  | 'unknown_role'
  | 'unknown_group'
  | 'invalid_token'
  | 'expired_token'
  | 'token_identity_mismatch'
  | 'last_owner'
  | 'no_owner_role';

const STATUS: Record<MembershipErrorCode, { status: number; retry: Retryable }> = {
  not_a_member: { status: 403, retry: 'needs-human' },
  insufficient_role: { status: 403, retry: 'needs-human' },
  insufficient_permission: { status: 403, retry: 'needs-human' },
  already_a_member: { status: 409, retry: 'change-input' },
  already_invited: { status: 409, retry: 'change-input' },
  unknown_role: { status: 422, retry: 'change-input' },
  unknown_group: { status: 404, retry: 'change-input' },
  invalid_token: { status: 404, retry: 'change-input' },
  expired_token: { status: 410, retry: 'change-input' },
  token_identity_mismatch: { status: 403, retry: 'needs-human' },
  last_owner: { status: 409, retry: 'change-input' },
  no_owner_role: { status: 422, retry: 'change-input' },
};

export function membershipError(code: MembershipErrorCode, message: string, details?: unknown): ForgeError {
  const { status, retry } = STATUS[code];
  return new ForgeError({ code, message, status, retry, details });
}
