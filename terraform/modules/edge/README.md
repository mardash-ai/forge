# forge module: edge

Global external entry point for the product — DNS zone, TLS certificates, load balancer, and the
mTLS host. Provisions two separate HTTPS entry points (MAIN + MCP) to keep browser-facing hosts
free from client-cert dialogs.

## Architecture

```
MAIN entry  — one global IP + HTTPS proxy for all browser/API hosts (site, www, app, api …)
              NO mTLS — attaching a ServerTlsPolicy to a shared proxy triggers cert pickers in browsers.

MCP entry   — a SECOND global IP + proxy for the mTLS host only.
              ALLOW_INVALID_OR_MISSING_CLIENT_CERT mode: certless /.well-known discovery must pass.
              The app fails closed by reading client_cert_* headers the backend adds.
```

The URL map is a singleton per entry. Each service owns its backend service; this module takes
`host_backends` (host → backend-service self_link). Hosts without a backend fall through to a
placeholder, making the module applyable standalone.

Certificates use Certificate Manager with DNS authorization, so they **provision before the DNS
cutover** — the zone can remain at the registrar until the registrar delegation step.

## Variables

| Name | Type | Default | Description |
|---|---|---|---|
| `project_id` | `string` | — | GCP project ID |
| `name` | `string` | — | Unique name prefix for all resources |
| `domain` | `string` | — | Apex domain, e.g. `dorinda.ai` |
| `main_hosts` | `list(string)` | — | Hosts served by the MAIN entry (must include any `external_dns_hosts`) |
| `mcp_host` | `string` | — | Dedicated mTLS host, e.g. `mcp.dorinda.ai` |
| `external_dns_hosts` | `set(string)` | `[]` | **See below.** Subset of `main_hosts` whose DNS is managed outside this Cloud DNS zone. |
| `host_backends` | `map(string)` | `{}` | `host → backend service self_link`. Add one entry here per onboarded service. |
| `mcp_trust_anchor_pem` | `string` | — | PEM of the root CA anchoring connector client certs. One block only. |
| `mcp_intermediate_pems` | `list(string)` | `[]` | Intermediate CA PEMs (one block each). |

## Hosts and DNS

### Internal DNS (default)

By default every host in `main_hosts` gets:
- A `google_dns_record_set` A record in the product Cloud DNS zone pointing to the MAIN LB IP.
- A Certificate Manager DNS authorization CNAME (placed at the registrar pre-cutover).
- A managed TLS certificate, cert-map entry, and URL map route.

The Cloud DNS zone is intended to be authoritative only after the registrar delegates to it (Phase 3
of provisioning). Before delegation, certs still provision because the DNS-authorization CNAMEs are
added at the registrar first (a 🔒 RUNBOOK step printed in the `dns_authorization_cnames` output).

### External DNS hosts (`external_dns_hosts`)

Some hosts' DNS is managed **outside** the product Cloud DNS zone (e.g. at GoDaddy). Setting
`external_dns_hosts` tells the module to skip the managed-zone A record for those hosts while
still creating everything else they need: certificate, DNS authorization, cert-map entry, URL map
route, and backend.

```hcl
module "edge" {
  source = "../../modules/edge"
  # …
  main_hosts         = ["dorinda.ai", "www.dorinda.ai", "forge.mardash.ai"]
  external_dns_hosts = ["forge.mardash.ai"]   # DNS at GoDaddy, not in our Cloud DNS zone
}
```

**Every entry in `external_dns_hosts` must also appear in `main_hosts`** — the module enforces
this with a lifecycle precondition on the DNS zone resource. Violating it produces:

```
│ Error: Resource precondition failed
│
│ Every entry in external_dns_hosts must also appear in main_hosts.
```

**Default behavior is unchanged.** When `external_dns_hosts = []` (the default), all `main_hosts`
get their A record set exactly as before — this is a strict no-op for existing configurations.

#### Operator runbook for external DNS hosts

After `terraform apply`, read the `external_dns_records` output:

```bash
terraform output -json external_dns_records
```

For each external host it prints two records that must be placed at the external DNS provider
(e.g. GoDaddy):

| Record | What to enter |
|---|---|
| `type = "A"`, `name = "<host>."` | Point the host at `data` (the MAIN LB IP) |
| `type = "CNAME"`, `name = "_acme-challenge.<host>."` | Set the CNAME to `data` (the DNS-authorization token) |

The CNAME is required for Certificate Manager to verify domain ownership. Add it **before**
expecting the certificate to become ACTIVE.

## Outputs

| Name | Description |
|---|---|
| `main_ip` | MAIN LB global IP address |
| `mcp_ip` | MCP LB global IP address |
| `dns_zone` | Cloud DNS managed zone name |
| `dns_name_servers` | NS records — delegate the zone at the registrar with these |
| `url_map_main` | MAIN URL map name |
| `url_map_mcp` | MCP URL map name |
| `mtls_trust_config` | Trust config resource ID |
| `mtls_server_tls_policy` | ServerTlsPolicy resource ID |
| `dns_authorization_cnames` | 🔒 RUNBOOK — all DNS-auth CNAMEs (name/type/data), for placement at the registrar pre-cutover |
| `external_dns_records` | 🔒 RUNBOOK — per external host: A record + CNAME that an operator must place at their external DNS provider |

## Provider version constraint

The module requires `hashicorp/google >= 6.0, < 8.0`.  This is intentionally wide so consumers
pinned at any 6.x or 7.x release can adopt the module without an empty-intersection error.
The module itself is tested with the latest 7.x provider; a consumer locked at `~> 6.0` can
run `terraform init -backend=false` against it successfully (see
`terraform/fixtures/edge-consumer/` for a working demonstration).

> **History:** Prior to this release the constraint was `~> 7.0`. Consumers locked at 6.x
> (`~> 6.0`, e.g. locked at 6.50.0) hit an empty-intersection init failure. The constraint was
> relaxed to `>= 6.0, < 8.0` in the same release that fixed the data-plane SMS-routes
> `FST_ERR_CTP_ALREADY_PRESENT` boot crash.

## Tests

```bash
cd terraform/modules/edge
terraform init -backend=false
terraform validate
terraform test
```

`terraform test` uses mock providers (no GCP credentials required) and covers:
1. External host gets cert + auth + cert-map entry but no managed-zone A record.
2. Non-external hosts keep their A record sets.
3. Empty `external_dns_hosts` is a strict no-op.
4. Precondition rejects an external host that is not in `main_hosts`.
