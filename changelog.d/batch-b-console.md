### Fixed

- **The progress bar divided a number by itself.** The denominator was `workflows_attempted` — the
  count of workflows that had already reported — so the bar could only ever read `n of n` at 100%,
  on a run that had barely started. It now divides by `meta.workflows_intended` (what this run was
  asked to do), falling back to `meta.catalogue_size`, with the bar and its trailing label reading
  the same value. An unknown target renders **no bar** rather than a full one: showing 100% against
  a denominator nobody reported is the same dishonesty relocated.

- **A workflow that did not pass now explains itself, in the right voice.** Mark: *"all of the trials
  had green checks for every step, yet the workflow was rejected. It was difficult to understand
  why."* The drawer opens with the reason — and rejected and withheld are deliberately worded
  differently. A rejection names the failing bar and explains that passing *some* attempts is still
  a rejection when the threshold is not met. A withheld workflow is stated as an **absence of a
  verdict**, in muted type, saying explicitly that it is not evidence against the product — sending
  someone to debug a product that did nothing wrong is the most expensive mistake this screen makes.

- **Copying a workflow's triage prompt now confirms itself** with the console's existing `✓ copied`
  flash, keyed per workflow so only the clicked row reacts — and fired only once the clipboard has
  actually accepted the text, never optimistically.
