# Phase 3 executable skill sandbox

Executable TypeScript and Python skills are never launched by the browser or Agent API process. The API performs package validation and static analysis, persists findings and approval state, then delegates approved work to `apps/sandbox-runner`.

The runner invokes Docker without a shell. Containers use no network, a read-only root filesystem, a non-root user, all capabilities dropped, `no-new-privileges`, PID/RAM/CPU/open-file limits, and explicit read-only/read-write bind mounts. Home directories, credentials, Docker socket, host environment files, and arbitrary host paths are never mounted.

Dependencies are denied by default and must be exactly pinned in the versioned allowlist. Install lifecycle scripts, URL/Git dependencies, missing lockfiles, traversal, dangerous process/network APIs, raw filesystem access, and unrestricted environment access produce findings. `forbidden` findings cannot be approved.

Generated changes belong in an isolated staging/output mount. Applying a diff to the real workspace remains a separate explicit user decision. Every scan, decision, execution state, output, resource report, and kill request is recorded in SQLite audit logs.

The browser supports manual packages and AI-generated packages. Both follow the same immutable gates: generation, checksum, TypeScript compiler diagnostics, custom TypeScript/Python security rules, dependency validation, explicit version approval, container execution, output validation, staged diff preview, explicit apply, and rollback. AI generation never activates or executes a skill by itself.

Sandbox output may request workspace changes using `{"files":{"tests/example.test.ts":"..."}}`. Only `tests/`, `src/`, and `.local-agent/output/` are eligible. The API rejects traversal and symlinks, previews before/after content, and applies each approved file using a temporary file plus atomic rename.

Build images explicitly when Docker is available:

```powershell
docker build -t local-agent-skill-node:phase3 -f apps/sandbox-runner/docker/node/Dockerfile .
docker build -t local-agent-skill-python:phase3 -f apps/sandbox-runner/docker/python/Dockerfile .
```
