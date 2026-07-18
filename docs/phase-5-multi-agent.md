# Phase 5 — Multi-agent coordination

Multi-agent execution is optional. `automatic` applies deterministic signals before any model call; `single` retains the Phase 1 orchestrator; `multi` creates a persisted Supervisor run.

The message bus validates correlation, causation and monotonically increasing sequence fields. Only Supervisor may delegate. Specialist agents return structured summaries to Supervisor and cannot broadcast or communicate directly. Global counters cap model calls, messages, delegations, revisions, retries and duration.

Security review and user approval are hard gates for executable skill creation. A failed specialist may fall back to the stable single-agent runtime only when no security or approval gate would be bypassed. Risk conflicts select the higher risk, forbidden/rejected actions cannot be overridden, and retries are bounded.

Use `/agents` to select the operating mode and inspect roles, ownership, assignments, messages and budget usage. `/tasks/:taskId/agents` shows one run. `GET /api/benchmarks/multi-agent` runs the deterministic ten-scenario local benchmark without consuming model tokens.
