# Local Agent OS — Phase 1 Web

Local-first AI agent with a React web interface, NestJS API, SQLite, and DeepSeek through Ollama. The runtime can use Ollama only, a paid OpenAI-compatible endpoint only, or local-first automatic fallback to the paid endpoint when local inference is unavailable.

Phase 2 adds a semantic skill registry, prompt/workflow proposals, versioning, approval workflows, safe ZIP import/export, Approval Center (`/approvals`), and Skill Studio (`/skills`). Executable TypeScript/Python generation remains forbidden.

## Requirements

- Node.js 22 (pinned to `22.22.2` in `.nvmrc`)
- Yarn 1.22
- [Ollama](https://ollama.com/download/windows)
- A modern browser such as Chrome, Edge, or Firefox

Rust, Tauri, Visual Studio Build Tools, and native desktop packaging are not required.

## Setup

```powershell
ollama pull deepseek-r1
ollama pull nomic-embed-text
Copy-Item .env.example .env
yarn install
yarn playwright install chromium
```

Set `AGENT_WORKSPACE` in `.env` to the only directory skills may access.

## Model and tool fallback

The default (`AI_PROVIDER=auto`) tries Ollama first and uses a paid OpenAI-compatible endpoint only if `OPENAI_API_KEY` is configured and local inference fails. Use `AI_PROVIDER=local` or `AI_PROVIDER=paid` to force one route. Optional values are `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL`, and `OPENAI_EMBED_MODEL`.

The agent creates a safe declarative recovery skill when routing fails or a compatible skill errors. Tool installation is deliberately constrained to the static `managedTools` allow-list and is enabled by default; set `AGENT_AUTO_INSTALL_TOOLS=false` to report missing tools without modifying the workspace.

Artifact requests are normalized to two concrete steps: read the requested source file and generate a verified file under `.local-agent/output`. Built-in generators support PDF, DOCX, XLSX, CSV, JSON, HTML, Markdown, TXT, and SVG. The task cannot complete until the requested artifact exists; the result panel provides a download link.

## Autonomous operation

`AGENT_AUTONOMOUS_PLANNER` is enabled by default. It lets the model infer the task's capabilities, success criteria, required artifact types, and whether to reuse, compose, create a skill, or install a tool. The model never emits shell commands or package names: local policy resolves those requests to a sandboxed skill or an allow-listed dependency. Set `AGENT_AUTONOMOUS_PLANNER=false` to retain deterministic routing only.

When a task needs extra filesystem, command, network, or environment access, the agent pauses and asks for approval. The same approval card appears before installing a missing tool or dependency; it lists the packages, package-manager command, workspace files, and registry hosts involved. Approval resumes the same task and permits only that request (or all future requests if the user explicitly chooses that option).

`OLLAMA_NUM_GPU=0` is the safe default and runs Ollama inference on CPU. Increase it only after confirming the local CUDA driver and Ollama GPU runner are stable.

## Run

Start the API:

```powershell
yarn dev:api
```

Start the web application in another terminal:

```powershell
yarn dev:web
```

Open [http://127.0.0.1:4200](http://127.0.0.1:4200) in your browser.

## Verify

```powershell
yarn lint
yarn typecheck
yarn test
yarn build
yarn e2e
```

REST exposes health, model health, skills, task CRUD/cancel, and task events. Socket.IO uses namespace `/agent`. See [architecture](docs/architecture.md).

## Phase 1 acceptance checklist

1. Start Ollama and verify `Invoke-RestMethod http://127.0.0.1:11434/api/tags` lists `deepseek-r1` and `nomic-embed-text`.
2. Run `yarn dev:api` and verify `Invoke-RestMethod http://127.0.0.1:3000/models/health` reports `chatModelAvailable: true`.
3. Run `yarn dev:web`, open the browser, submit a reporting or filesystem task, and confirm it reaches `completed` with persisted timeline events.
4. Run all verification commands above.

Ollama is the only remaining machine-level prerequisite and is intentionally not installed or managed by the application.

## Native dependency troubleshooting

`better-sqlite3` must be compiled with the same Node major version that runs the API. Confirm the active runtime before installing:

```powershell
node --version
node -p "process.versions.modules"
yarn install
```

This repository expects ABI `127` from Node 22. If Node reports another ABI, switch to Node 22 and rebuild dependencies:

```powershell
nvm use 22.22.2
yarn install --force
```
