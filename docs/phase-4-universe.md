# Phase 4 Skill Universe and observability

`/universe` is a lazy-loaded React Three Fiber scene backed by the same pure graph reducer as the accessible 2D graph and skill table. Registry skills form stable radial nodes around Agent Core. Persisted and WebSocket events add task nodes, active execution edges, candidate/selection state, skill-creation wireframes, approval badges, and completion/failure state without exposing model reasoning.

WebSocket events are batched per animation frame and history is bounded to 1,000 events. Node geometry is shared by React Three Fiber lifecycle management, layouts are deterministic, labels remain HTML, quality presets cap pixel ratio, reduced-motion disables pulsing/damping, and the entire Three.js chunk is excluded from normal Workspace routes.

WebGL detection automatically selects the 2D graph. Users may switch manually, search nodes, inspect or disable a skill from the drawer, and use the keyboard-accessible table. GPU telemetry reports `Not available` when unsupported.

`/tasks/:taskId/inspect` reconstructs visual state only from persisted operational events. Replay never executes a skill and supports play, pause, step, jump, and 0.5–4x speed. Structured analysis, plan, sandbox output, diff, logs, validation, errors, and resources are shown without raw chain-of-thought.

`/workflows/new` and `/workflows/:id` provide a declarative drag/drop editor. The client and API both reject missing dependencies and cycles. Saving creates a workflow skill composed only from active registry skills; no executable expression or free-form code is accepted.
