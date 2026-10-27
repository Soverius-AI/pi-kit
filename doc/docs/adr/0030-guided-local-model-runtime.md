# ADR-0030: Manage local models through the user's existing llama-swap config

Status: Accepted
Date: 2026-10-18

## Context

pi-kit's local-model flow created a private llama-swap engine with its own config, port and provider. A user who already runs llama-swap with a config and downloaded models sees none of that in pi-kit, and the add-provider wizard lists only servers that answer, so a stopped llama-swap cannot be added at all.
Model management also carried context tuning, benchmarks and probes that duplicate what the engine configuration decides. Download jobs kept their identity only in memory, so a restart lost the retry. Per-model options and speculative decoding could only be edited by hand in YAML.
Constraints: no second engine or provider, no plaintext credentials in caches, never execute commands or macros found in config files, and never touch a llama-swap process pi-kit did not start.

## Decision

- Onboarding and Settings › Local models share one component with the tabs **Your models**, **Download models** and **Engines**. The library lists discovered GGUF files with size, source and registration, and reads model names from the existing llama-swap YAML files, also while the service is stopped. Deleting a file requires confirmation naming file, path and bytes and removes only tracked entries for that file.
- Discovery reads `-config` / `--config` and `-config-dir` from running llama-swap processes and from launchd/systemd service definitions. Priority: explicit choice or environment path, active service, stopped service definition, remembered path, conventional location. Only detected paths are cached; raw command lines and credentials are never stored. A broken active config stays the repair target.
- No private server or config. Downloads require a detected existing config; only first-time tool installation creates a standard shared XDG config. The old private config is kept as a backup and never started; its autostart is disabled; an unchanged provider owned by that flow is removed, user-defined providers are kept.
- Edit YAML reuses `FileEditorDialog` and `PkCodeEditor` with validation, diagnostics, unsaved-change handling and versioned atomic saves. Content hashes refuse external changes; saves retain permissions, symlinks and exact text. The editor never executes commands or restarts the service. Reads are bounded to regular files up to 2 MB.
- Downloads are file-specific: search Hugging Face, pick a pinned file, review source, licence, size and memory estimate, confirm. The backend owns the job and persists action, repository, filename, revision, size and checksum before work starts; retry after a restart uses that snapshot. Incomplete transfers restart; verified files are reused. Cleanup removes only owned partial files in pi-kit's download directory.
- A verified download is registered in the selected llama-swap YAML; existing files get **Add to llama-swap**. Writes preserve comments, commands, engine options, permissions and symlinks, use stable collision-resistant names and check for intervening edits before replacing the file. Only registrations pi-kit added can be removed. Context, GPU layers and parallelism are engine settings.
- Existing matching providers learn new model IDs from the running service; no second provider is created. Engines installs missing llama.cpp/llama-swap through Homebrew on macOS/Linux and shows manual instructions elsewhere; installing never launches a server.
- Each model in a detected config has **Configure**, with **Runtime**, **Generation defaults** and **MTP** tabs over `GET`/`POST setup/local-runtime/model-options`. Saves carry the loaded SHA-256 version and only changed fields; the YAML AST preserves other models, comments, options and macros; macros are never evaluated. MTP activation requires a readable GGUF with `nextn_predict_layers` metadata and an installed llama-server whose help lists MTP support.
- **Save and reload model** is a backend-owned job: it updates the YAML, rechecks the content hash and the PID/config/listener binding, lets the existing watcher apply the file or sends SIGHUP, then loads the model through its upstream route until `/running` reports it ready. It never starts a separate daemon; stopping the wait aborts observation only.
- pi-kit starts and stops the user's llama-swap. `POST /api/setup/local-runtime/start` runs the installed `llama-swap` with the selected config on the loopback listener with `-watch-config`, in its own process group (`taskkill /T` on Windows); `POST …/stop` and backend shutdown end it. When something already answers on the listener, start refuses. `autostart` saves `{ configPath, listen }`; the `managed` status is part of `GET /api/setup/local-runtime`, and the managed listener is probed like any other server.
- `GET …/doctor` names what keeps the selected config from running: llama-swap missing, config missing or invalid, no models, a model file gone, a launcher gone. `POST …/repair` applies only fixable findings under the doctor's content hash: entries without a file are removed, a missing `llama-server` launcher is repointed; comments and every other line stay. Invalid YAML and custom launchers go to Advanced YAML.
- Context tuning, standalone benchmarks, performance panels and forced inference/tool probes are removed from model management.
- The Nest module separates discovery, catalogue, files, config updates and job orchestration. Shared Zod schemas define `/api/setup/local-runtime`; OpenAPI and `shared/api` are generated. Job and registration metadata live in the encrypted settings database; a restart marks interrupted jobs failed and keeps their retry identity. Labels use the shared English/German catalogs.

## Consequences

- The user's own llama-swap is the only engine; pi-kit owns only the process it started and never signals, stops or redirects another one.
- Saving model options does not restart the engine; they apply on the next model load. Reloading the configuration can unload other models or interrupt active requests, and the UI says so.
- Catalogue discovery covers verified single-file language GGUFs from curated publishers; split or gated repositories and separate vision projectors need manual setup. The memory estimate is advisory.
- Legacy download jobs without a persisted identity cannot be retried; they offer **Find model again** and **Dismiss**.
- Config-only entries claim no disk size and offer no deletion; live server listings are shown separately with their address.
