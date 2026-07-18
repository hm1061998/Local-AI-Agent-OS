# Phase 1 architecture

The React/Vite web application uses REST and the `/agent` Socket.IO namespace. The NestJS orchestrator owns the finite-state machine, execution budget, and cancellation controller. Every operational event is persisted to SQLite before emission.

Only the model gateway calls Ollama. Analysis is Zod-validated structured output with one retry. The router scores six static manifests. The restricted executor resolves paths below `AGENT_WORKSPACE` and runs only four exact test commands with `shell: false`.

SQLite tables: `tasks`, `task_events`, `skills`, `skill_executions`, `model_calls`, and `audit_logs`.

## Phase 2 declarative skills

The semantic registry combines Ollama embeddings with trigger, historical success, input compatibility, and preference scores. It falls back to explainable keyword ranking when embeddings are unavailable. The factory creates only prompt/workflow proposals; a user decision in Approval Center is required before activation. Versions are immutable, rollback creates a new patch version, workflow graphs are cycle-checked without `eval`, and ZIP imports reject absolute or parent-traversal paths before schema validation.

Phase 2 adds `skill_versions`, `skill_embeddings`, `skill_usage_metrics`, `skill_dependencies`, and `skill_approvals`.
