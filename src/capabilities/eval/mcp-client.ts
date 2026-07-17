// The eval harness's MCP client (C30).
//
// Mints a BROWSERLESS access token for an eval user and speaks JSON-RPC 2.0 over the forge
// Streamable-HTTP transport (`tools/list`, `tools/call`) — the SAME transport a real Claude/GPT
// connector uses, so the eval exercises (and, via C36, traces) the real path
// transport → app handler → dispatch. The token is minted by writing an access grant directly to
// the mcp backend (no PKCE/consent/browser), scoped `owner` because dorinda registers every tool
// with `scope: "owner"`.

import { getBackends } from '../../storage/backends';
import { newToken } from '../../plugins/auth-identity/index';
import { expiresAtIso, accessTtlSeconds } from '../../mcp/oauth';
import { nowIso } from '../../shared/time';
import type { EvalTool } from './models';

export interface McpClient {
  readonly token: string;
  listTools(): Promise<EvalTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }>;
}

/** Mint an access grant for (appId, ownerId) directly in the mcp backend — the browserless path
 * the eval runner uses in place of the interactive OAuth authorization-code flow. Returns the raw
 * bearer (only its hash is stored). Scoped `owner`; TTL = the platform access-token TTL (1h). */
export async function mintAccessToken(appId: string, ownerId: string): Promise<string> {
  const raw = newToken();
  await (await getBackends()).mcp.putGrant(appId, {
    kind: 'access',
    token_hash: raw.hash,
    client_id: 'eval-harness',
    owner: ownerId,
    scopes: ['owner'],
    expires_at: expiresAtIso(accessTtlSeconds()),
    visibility: 'private',
    created_at: nowIso(),
  });
  return raw.token;
}

/** An MCP client bound to `mcpUrl`, authenticated as the eval user. `mcpUrl` is the app's public
 * `/mcp` (or the sidecar `/mcp`); `X-Forge-App` resolves the app when hitting the sidecar directly. */
export function mcpClient(opts: {
  mcpUrl: string;
  appName: string;
  token: string;
  fetchImpl?: typeof fetch;
}): McpClient {
  const doFetch = opts.fetchImpl ?? fetch;
  let id = 0;
  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const res = await doFetch(opts.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.token}`,
        'X-Forge-App': opts.appName,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    return body;
  };
  return {
    token: opts.token,
    async listTools() {
      const r = await rpc('tools/list');
      const tools =
        (r.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> })
          ?.tools ?? [];
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object' },
      }));
    },
    async callTool(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      if (r.error) return { ok: false, result: { error: r.error } };
      const result = r.result as { isError?: boolean } | undefined;
      return { ok: !result?.isError, result: r.result };
    },
  };
}
