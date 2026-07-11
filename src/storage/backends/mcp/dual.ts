import type { FsMcpBackend } from './fs';
import type { PgMcpBackend } from './pg';
import type { McpBackend } from './types';
import type {
  ToolRegistration,
  InstructionBlock,
  OAuthClient,
  Consent,
  OAuthGrant,
  GrantKind,
} from '../../../mcp/types';

// C23 / P26 — the DUAL-WRITE MCP backend: Postgres is the source of truth (reads); every write also mirrors
// to the filesystem, for a reversible cutover. FORGE_MCP_BACKEND=postgres + FORGE_MCP_DUAL_WRITE=1.
// NOTE: one-shot reads (consumeGrant) go ONLY to the primary — mirroring a delete-returning to the
// secondary would let the FS copy be double-spent; the FS mirror is a cold standby, not a second spender.
export class DualWriteMcpBackend implements McpBackend {
  constructor(private readonly primary: PgMcpBackend, private readonly secondary: FsMcpBackend) {}

  // reads → primary
  getTool(appId: string, name: string): Promise<ToolRegistration | null> { return this.primary.getTool(appId, name); }
  listTools(appId: string): Promise<ToolRegistration[]> { return this.primary.listTools(appId); }
  latestInstructions(appId: string): Promise<InstructionBlock | null> { return this.primary.latestInstructions(appId); }
  getInstructions(appId: string, version: number): Promise<InstructionBlock | null> { return this.primary.getInstructions(appId, version); }
  listInstructions(appId: string): Promise<InstructionBlock[]> { return this.primary.listInstructions(appId); }
  getClient(appId: string, clientId: string): Promise<OAuthClient | null> { return this.primary.getClient(appId, clientId); }
  getConsent(appId: string, clientId: string, owner: string): Promise<Consent | null> { return this.primary.getConsent(appId, clientId, owner); }
  listConsents(appId: string, owner: string): Promise<Consent[]> { return this.primary.listConsents(appId, owner); }
  getGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null> { return this.primary.getGrant(appId, kind, tokenHash); }

  // writes → primary then mirror
  async putTool(appId: string, tool: ToolRegistration): Promise<ToolRegistration> {
    const t = await this.primary.putTool(appId, tool);
    await this.secondary.putTool(appId, tool);
    return t;
  }
  async deleteTool(appId: string, name: string): Promise<boolean> {
    const ok = await this.primary.deleteTool(appId, name);
    await this.secondary.deleteTool(appId, name);
    return ok;
  }
  async appendInstructions(appId: string, input: { text: string; label?: string; created_at: string }): Promise<InstructionBlock> {
    const b = await this.primary.appendInstructions(appId, input);
    // Mirror the SAME version to keep the standby faithful.
    await this.secondary.importVersion(appId, b);
    return b;
  }
  async putClient(appId: string, client: OAuthClient): Promise<OAuthClient> {
    const c = await this.primary.putClient(appId, client);
    await this.secondary.putClient(appId, client);
    return c;
  }
  async putConsent(appId: string, consent: Consent): Promise<Consent> {
    const c = await this.primary.putConsent(appId, consent);
    await this.secondary.putConsent(appId, consent);
    return c;
  }
  async revokeConsent(appId: string, clientId: string, owner: string): Promise<boolean> {
    const ok = await this.primary.revokeConsent(appId, clientId, owner);
    await this.secondary.revokeConsent(appId, clientId, owner);
    return ok;
  }
  async putGrant(appId: string, grant: OAuthGrant): Promise<OAuthGrant> {
    const g = await this.primary.putGrant(appId, grant);
    await this.secondary.putGrant(appId, grant);
    return g;
  }
  consumeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null> {
    // One-shot: only the primary consumes; leave the FS mirror as a cold copy (never a 2nd spender).
    return this.primary.consumeGrant(appId, kind, tokenHash);
  }
  async revokeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<boolean> {
    const ok = await this.primary.revokeGrant(appId, kind, tokenHash);
    await this.secondary.revokeGrant(appId, kind, tokenHash);
    return ok;
  }
  async revokeUserGrants(appId: string, owner: string): Promise<number> {
    const n = await this.primary.revokeUserGrants(appId, owner);
    await this.secondary.revokeUserGrants(appId, owner);
    return n;
  }
}
