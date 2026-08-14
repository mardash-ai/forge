### Fixed

- **The run modal sent a provider the runner cannot accept.** Ticking both provider boxes produced
  `provider: "openai, anthropic"` — a display label, not one of `openai` | `anthropic` | `both` — so
  the runner refuses the run outright rather than guessing. The label is still shown in the reason
  line; the request now carries `both`.
