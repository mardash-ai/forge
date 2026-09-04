terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      # Consumer locked at ~> 6.0 (≥ 6.0, < 7.0). This fixture proves the edge module's
      # ">= 6.0, < 8.0" constraint intersects correctly with a 6.x consumer.
      # Before the fix (edge was "~> 7.0"), terraform init failed with an empty-intersection
      # error; after the fix, any 6.x version satisfies both constraints.
      version = "~> 6.0"
    }
  }
}
