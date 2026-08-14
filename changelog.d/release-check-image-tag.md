### Fixed

- **The release delivery-check asked the registry for a tag that is never created.** Releases are
  git-tagged `v1.31.0`; `docker/metadata-action` publishes `type=semver,{{version}}`, which strips
  the `v`, so the image is `1.31.0`. The check looked up `v1.31.0`, missed a perfectly published
  image, and reported "not published in the registry" on **every** release — a guard that is red
  whenever it runs is one everybody learns to ignore. It now tries the tag as given and then
  v-stripped, and whichever resolves is the truth.
