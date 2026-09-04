# Tests for the external_dns_hosts feature of the edge module.
#
# Three behavioral guarantees are covered:
#
#   1. An external host gets its cert + DNS authorization + cert-map entry but NO managed-zone A record set.
#   2. Non-external hosts in main_hosts continue to get their managed-zone A record set (no behavior change
#      for the default empty case).
#   3. The precondition rejects any external_dns_hosts entry that is NOT also in main_hosts.
#      (We test this by setting external_dns_hosts to the mcp_host, which IS in all_hosts — so the
#      auth resource exists and the plan succeeds — but is NOT in main_hosts, so the lifecycle
#      precondition fires during apply.)
#
# Uses mock_provider so no real GCP credentials are needed.

mock_provider "google" {
  # Provide a dns_resource_record list so the dns_authorization_cnames and external_dns_records
  # outputs can index into [0] — the mock provider otherwise generates an empty list.
  mock_resource "google_certificate_manager_dns_authorization" {
    defaults = {
      dns_resource_record = [{
        name = "_acme-challenge.mock.example.com."
        type = "CNAME"
        data = "mock-auth-token.4.authorize.certificatemanager.goog."
      }]
    }
  }
}

variables {
  project_id   = "test-project"
  name         = "edge"
  domain       = "example.com"
  main_hosts   = ["example.com", "www.example.com", "forge.example.com"]
  mcp_host     = "mcp.example.com"
  mcp_trust_anchor_pem = <<-PEM
    -----BEGIN CERTIFICATE-----
    MIIBpDCCAQqgAwIBAgIUYxQn3fake0000000000000000000test==
    -----END CERTIFICATE-----
  PEM
}

# ── Test 1: external host gets cert + auth + cert-map entry but NO managed-zone A record ──────────
run "external_host_gets_cert_and_auth_but_no_record_set" {
  variables {
    external_dns_hosts = ["forge.example.com"]
  }

  # The external host must NOT appear in google_dns_record_set.main_a.
  assert {
    condition     = !contains(keys(google_dns_record_set.main_a), "forge.example.com")
    error_message = "external_dns_hosts entry 'forge.example.com' must NOT get a managed-zone A record set"
  }

  # The external host MUST still get a Certificate Manager DNS authorization.
  assert {
    condition     = contains(keys(google_certificate_manager_dns_authorization.auth), "forge.example.com")
    error_message = "external_dns_hosts entry 'forge.example.com' must still get a Certificate Manager DNS authorization"
  }

  # The external host MUST still get a certificate.
  assert {
    condition     = contains(keys(google_certificate_manager_certificate.cert), "forge.example.com")
    error_message = "external_dns_hosts entry 'forge.example.com' must still get a certificate"
  }

  # The external host MUST still have a cert-map entry (so TLS terminates at the proxy).
  assert {
    condition     = contains(keys(google_certificate_manager_certificate_map_entry.main), "forge.example.com")
    error_message = "external_dns_hosts entry 'forge.example.com' must still get a certificate map entry"
  }

  # external_dns_records output must include the external host with exactly two records (A + CNAME).
  assert {
    condition     = contains(keys(output.external_dns_records), "forge.example.com")
    error_message = "external_dns_records output must include 'forge.example.com'"
  }

  assert {
    condition     = length(output.external_dns_records["forge.example.com"]) == 2
    error_message = "external_dns_records['forge.example.com'] must list exactly two records (A record + DNS-authorization CNAME)"
  }

  # First record is the A record.
  assert {
    condition     = output.external_dns_records["forge.example.com"][0].type == "A"
    error_message = "external_dns_records['forge.example.com'][0].type must be 'A'"
  }

  # Second record is the CNAME.
  assert {
    condition     = output.external_dns_records["forge.example.com"][1].type == "CNAME"
    error_message = "external_dns_records['forge.example.com'][1].type must be 'CNAME'"
  }
}

# ── Test 2: non-external hosts keep their managed-zone A record sets ───────────────────────────────
run "non_external_hosts_keep_record_sets" {
  variables {
    external_dns_hosts = ["forge.example.com"]
  }

  assert {
    condition     = contains(keys(google_dns_record_set.main_a), "example.com")
    error_message = "non-external host 'example.com' must keep its managed-zone A record set"
  }

  assert {
    condition     = contains(keys(google_dns_record_set.main_a), "www.example.com")
    error_message = "non-external host 'www.example.com' must keep its managed-zone A record set"
  }
}

# ── Test 3: empty external_dns_hosts is a strict no-op (all main_hosts get A record sets) ──────────
run "empty_external_dns_hosts_is_noop" {
  variables {
    external_dns_hosts = []
  }

  assert {
    condition     = toset(keys(google_dns_record_set.main_a)) == toset(["example.com", "www.example.com", "forge.example.com"])
    error_message = "With external_dns_hosts=[], all three main_hosts must get managed-zone A record sets"
  }

  assert {
    condition     = length(output.external_dns_records) == 0
    error_message = "external_dns_records must be empty when external_dns_hosts is empty"
  }
}

# ── Test 4: precondition rejects an external host that is not in main_hosts ────────────────────────
# We use the mcp_host here: it IS in all_hosts (so auth["mcp.example.com"] exists and no invalid
# reference error occurs), but it is NOT in main_hosts (so the lifecycle precondition fires).
# In Terraform 1.9+, lifecycle preconditions are evaluated during planning; command=plan is
# therefore required so that expect_failures correctly catches the plan-stage failure.
run "precondition_rejects_host_not_in_main_hosts" {
  command = plan

  variables {
    external_dns_hosts = ["mcp.example.com"]
  }

  # The lifecycle precondition on google_dns_managed_zone.zone must fire.
  expect_failures = [google_dns_managed_zone.zone]
}
