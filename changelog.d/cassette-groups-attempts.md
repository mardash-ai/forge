### Changed

- **The cassette separates its attempts.** A workflow runs N attempts, each an independent fresh
  conversation that says "Use Dorinda." exactly once. The panel rendered all of them as one
  continuous scroll, so a user behaving exactly to contract appeared to repeat themselves (Mark,
  2026-08-14: *"is it having the user say 'Use Dorinda' far too often?"*). It was not — but evidence
  that misrepresents its own structure is a defect even when every value in it is true. Turns now
  carry `attempt` end to end (`forge_cp_eval_turns.attempt`), and the panel renders a labelled
  divider between conversations.
