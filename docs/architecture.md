# Phase 1 architecture

The React/Vite web application uses REST and the `/agent` Socket.IO namespace. The NestJS orchestrator owns the finite-state machine, execution budget, and cancellation controller. Every operational event is persisted to SQLite before emission.

Only the model gateway calls Ollama. Analysis is Zod-validated structured output with one retry. The router scores six static manifests. The restricted executor resolves paths below `AGENT_WORKSPACE` and runs only four exact test commands with `shell: false`.

SQLite tables: `tasks`, `task_events`, `skills`, `skill_executions`, `model_calls`, and `audit_logs`.
