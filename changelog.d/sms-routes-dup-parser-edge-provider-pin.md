### Fixed

- **Data-plane boot crash (FST_ERR_CTP_ALREADY_PRESENT)**: `registerSmsRoutes` now uses
  `removeContentTypeParser` before `addContentTypeParser` in its Twilio webhook child scope.
  Fastify copies the parent scope's parser map into every child scope; calling
  `addContentTypeParser('application/x-www-form-urlencoded', ...)` after `registerAuthRoutes`
  had already added the same type to the parent threw `FST_ERR_CTP_ALREADY_PRESENT` at plugin
  load time, preventing forge-data-plane-00028 from ever binding port 3718. The fix is safe on
  a clean instance (remove is a no-op when absent) and preserves the raw-string parser the
  Twilio HMAC-SHA1 signature verification requires. Added assembled data-plane and control-plane
  server boot tests that are RED against the old composition and GREEN after the fix.

- **Terraform edge module google-provider over-pin**: `terraform/modules/edge/versions.tf`
  google constraint relaxed from `~> 7.0` to `>= 6.0, < 8.0`. Consumers locked at `~> 6.0`
  (e.g. locked at 6.50.0) previously hit an empty-intersection `terraform init` failure because
  the module required a 7.x provider that the consumer's lock file could not satisfy. The
  relaxed constraint accepts any 6.x or 7.x provider and is validated by the new
  `terraform/fixtures/edge-consumer/` fixture root.
