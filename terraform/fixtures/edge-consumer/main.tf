# Fixture: edge-consumer
#
# Mirrors a consumer root that uses the edge module while pinned at google ~> 6.0.
# Purpose: prove the edge module's ">= 6.0, < 8.0" constraint allows a 6.x consumer to adopt it.
#
# RED (before fix): edge was "~> 7.0" — empty intersection with "~> 6.0"; terraform init failed.
# GREEN (after fix): edge is ">= 6.0, < 8.0" — intersection ">= 6.0, < 7.0" is non-empty; init succeeds.
#
# Run: terraform init -backend=false  (from this directory, no GCP credentials required)
#      terraform validate

module "edge" {
  source = "../../modules/edge"

  project_id  = "fixture-project"
  name        = "fixture"
  domain      = "example.com"
  main_hosts  = ["example.com", "www.example.com"]
  mcp_host    = "mcp.example.com"

  mcp_trust_anchor_pem = "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0\n-----END CERTIFICATE-----\n"
}
