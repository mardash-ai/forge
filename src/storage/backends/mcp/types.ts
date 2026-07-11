import type {
  ToolRegistration,
  InstructionBlock,
  OAuthClient,
  Consent,
  OAuthGrant,
  GrantKind,
  McpExport,
} from '../../../mcp/types';

// C23 / P26 — the pluggable McpBackend interface (the MCP-host + OAuth store). Same seam as every other
// store domain: a filesystem implementation (a per-app guarded JSON doc) and a Postgres implementation
// (one table per record kind). It holds five logical groups of per-app state:
//   - tools:        the app's declared tool surface (app-wide config).
//   - instructions: the versioned "training"/instruction blocks the host reads.
//   - clients:      OAuth dynamic client registrations.
//   - consents:     which user granted which client which scopes (O4-scoped; revocable).
//   - grants:       authorization codes + access/refresh tokens, HASHED at rest (secrets), one-shot for
//                   codes + refresh (consumeGrant is an atomic delete-returning).
export interface McpBackend {
  // tools
  putTool(appId: string, tool: ToolRegistration): Promise<ToolRegistration>; // upsert by name
  getTool(appId: string, name: string): Promise<ToolRegistration | null>;
  listTools(appId: string): Promise<ToolRegistration[]>;
  deleteTool(appId: string, name: string): Promise<boolean>;

  // instruction / training blocks (versioned; append assigns the next version)
  appendInstructions(appId: string, input: { text: string; label?: string; created_at: string }): Promise<InstructionBlock>;
  latestInstructions(appId: string): Promise<InstructionBlock | null>;
  getInstructions(appId: string, version: number): Promise<InstructionBlock | null>;
  listInstructions(appId: string): Promise<InstructionBlock[]>;

  // OAuth clients
  putClient(appId: string, client: OAuthClient): Promise<OAuthClient>;
  getClient(appId: string, clientId: string): Promise<OAuthClient | null>;

  // consent
  putConsent(appId: string, consent: Consent): Promise<Consent>;
  getConsent(appId: string, clientId: string, owner: string): Promise<Consent | null>;
  listConsents(appId: string, owner: string): Promise<Consent[]>;
  revokeConsent(appId: string, clientId: string, owner: string): Promise<boolean>;

  // grants (codes + access/refresh tokens); token_hash is the sha256 of the opaque secret
  putGrant(appId: string, grant: OAuthGrant): Promise<OAuthGrant>;
  getGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null>;
  consumeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null>; // atomic one-shot
  revokeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<boolean>;
  revokeUserGrants(appId: string, owner: string): Promise<number>; // cut a user's connectors off

  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

export interface MigratableMcpBackend {
  exportApp(appId: string): Promise<McpExport>;
  importApp(appId: string, data: McpExport): Promise<void>;
}
