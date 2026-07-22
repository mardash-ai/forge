// C23 — remote MCP-server hosting + OAuth 2.1 authorization server (GENERIC, product-agnostic). The
// platform hosts a consuming app's declared tool surface as a remote MCP server (Streamable-HTTP), acts
// as the OAuth authorization SERVER that gates it, serves a versioned "training"/instruction block to the
// connecting host, and schedules proactive prompts via C2. Nothing here is app-specific: an app registers
// its OWN tools + instruction text + scopes; the meaning of those is the app's domain.

// --- tool registration ----------------------------------------------------------

// The safety family of a tool — the hint the C29 governance seam uses. `read` never mutates; `write`
// mutates owned data; `action` has an external/irreversible effect (send, pay, …). The app declares it.
export type ToolFamily = 'read' | 'write' | 'action';

// A tool the app publishes to the MCP host. The platform serves { name, description, input_schema } as an
// MCP tool and DISPATCHES each `tools/call` to `handler_path` on the app (the C2 sidecar→app callback).
export interface ToolRegistration {
  name: string; // MCP tool name — unique per app (a-z0-9_-)
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema for the arguments
  output_schema?: Record<string, unknown>; // optional JSON Schema for the result
  scope: string; // the OAuth scope a token must hold to call this tool
  family: ToolFamily; // read | write | action (the C29 seam hint)
  high_risk?: boolean; // app hint: this tool is a high-risk class (staging suggested at the app's authorize())
  // MCP tool-annotation hints (optional; all snake_case at rest, surfaced camelCase under `annotations`
  // on tools/list). The MCP host uses them as behavioural hints — none is forced/defaulted; the app opts in.
  title?: string; // MCP annotation: a human-readable display title for the tool
  read_only_hint?: boolean; // MCP annotation: the tool does not modify its environment
  destructive_hint?: boolean; // MCP annotation: the tool may perform destructive updates (only if not read-only)
  idempotent_hint?: boolean; // MCP annotation: repeated calls with the same args have no additional effect
  open_world_hint?: boolean; // MCP annotation: the tool interacts with an open/external world (vs a closed domain)
  handler_path: string; // app path the platform POSTs the call to, e.g. /api/mcp/tools/create_note
  created_at: string;
  updated_at: string;
}

// --- versioned instruction / training block -------------------------------------

// The prompt-shaped connector description / tool preamble the app declares. The platform SERVES + VERSIONS
// it to the connecting host (A/B-testable later). It is text the host reads — never inference.
export interface InstructionBlock {
  version: number; // monotonic per app (1, 2, 3, …)
  text: string;
  label?: string; // optional A/B label
  created_at: string;
}

// --- OAuth 2.1 authorization-server records -------------------------------------

// A dynamically-registered OAuth client (RFC 7591). `none` = a PUBLIC client (PKCE, no secret) — the norm
// for the Apps SDK / MCP connector; a confidential client stores only its secret HASH.
export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  client_secret_hash?: string; // confidential clients only (never the raw secret)
  scope?: string; // space-delimited default scopes
  created_at: string;
}

export type Visibility = 'private' | 'shared';

// A CONSENT grant — user `owner` allowed `client_id` these scopes. Lets the platform skip re-consent on a
// repeat authorize / refresh, and is the record a user revokes to cut a connector off. O4-scoped.
export interface Consent {
  client_id: string;
  owner: string; // the C10/C11 user id
  scopes: string[];
  group_id?: string;
  visibility?: Visibility;
  created_at: string;
  updated_at: string;
}

// A GRANT secret — an authorization code, an access token, or a refresh token. Stored HASHED at rest
// (sha256 of the opaque value), like the C10 verify/reset/refresh tokens, so a store leak can't be
// replayed. Scoped + expiring; codes + refresh tokens are one-shot (consumeGrant).
export type GrantKind = 'code' | 'access' | 'refresh';

export interface OAuthGrant {
  kind: GrantKind;
  token_hash: string; // sha256(opaque token/code)
  client_id: string;
  owner: string; // the user id the grant acts as
  scopes: string[];
  expires_at: string; // ISO
  // PKCE (authorization codes only).
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';
  redirect_uri?: string;
  // Rotation lineage (refresh tokens).
  parent_hash?: string;
  group_id?: string;
  visibility?: Visibility;
  created_at: string;
}

// The full per-app MCP-host state (used by the migration surface).
export interface McpExport {
  tools: ToolRegistration[];
  instructions: InstructionBlock[];
  clients: OAuthClient[];
  consents: Consent[];
  grants: OAuthGrant[];
}
