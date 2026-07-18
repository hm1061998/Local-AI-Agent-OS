# Local Agent OS — Phase 1 Web

Local-first AI agent with a React web interface, NestJS API, SQLite, and DeepSeek through Ollama. Phase 1 includes structured task analysis, six static skills, a bounded FSM orchestrator, persisted operational events, cancellation, and a live execution timeline. It does not generate executable skills.

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
