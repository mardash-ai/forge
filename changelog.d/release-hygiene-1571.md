### Fixed

- **Release hygiene for the HTTP gating release.** `v1.57.0` was tagged by hand before its changelog entry existed, so its publish failed the release-hygiene test and no image shipped; the entry was added afterwards. This is the first publishable build of the four HTTP gating fixes listed under 1.57.0.
