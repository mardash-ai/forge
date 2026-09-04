---
bump: minor
---

### Added

- **`terraform/modules/edge`**: new `external_dns_hosts` variable (`set(string)`, default `[]`) — hosts in `main_hosts` whose DNS is managed outside the product Cloud DNS zone. These hosts still get their certificate, Certificate Manager DNS authorization, cert-map entry, URL map route and backend; the managed-zone `google_dns_record_set` is skipped for them. Default (empty set) is a strict no-op.
- **`terraform/modules/edge`**: `external_dns_records` output — per external host, the two records (A record: host → edge IP; CNAME: DNS-authorization token) an operator must place at their external DNS provider.
- **`terraform/modules/edge`**: lifecycle precondition on `google_dns_managed_zone.zone` that rejects any `external_dns_hosts` entry not also present in `main_hosts`, with a plain error message.
- **`terraform/modules/edge`**: `versions.tf` pinning the google provider (`~> 7.0`) so `terraform init -backend=false && terraform validate` work without credentials.
- **`terraform/modules/edge/tests/external_dns_hosts.tftest.hcl`**: four `terraform test` cases (mock provider, no credentials required) covering the record-set exclusion, backward-compat no-op, and precondition enforcement.
- **`terraform/modules/edge/README.md`**: module documentation covering hosts, DNS, external DNS hosts operator runbook, variables, outputs, and test instructions.
