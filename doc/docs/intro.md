---
slug: /
title: pi-kit
sidebar_label: Start here
sidebar_position: 0
---

# pi-kit

pi-kit is a desktop app for the [pi](https://github.com/earendil-works/pi) coding agent: an Electron shell, an Angular renderer
and a NestJS backend that runs pi's SDK in-process and talks to the renderer over [AG-UI](https://docs.ag-ui.com), hosted by the
open-source CopilotKit runtime. pi's own session files stay the source of truth, so the `pi` command line and the app share
every conversation.

This site is the documentation of the code base. It is written for the people who change it.

| Page | What it answers |
|---|---|
| [Architecture](architecture.md) | How the three processes fit together, what a turn goes through, how the renderer is layered, how background agents run. |
| [Backend](backend.md) | One folder per domain and four roles in each, the request path, what every folder owns, the steps for a new route, domain, table, stream or extension. |
| [AG-UI events](agui-events.md) | How a run streams from pi to the renderer, every event and custom event, replay and compaction, interrupts, and a review of the pipeline. |
| [Background agents](background-agents.md) | Subagents a thread spawns: spawning, permissions, questions, reports, recovery, and a review of the implementation. |
| [Repository structure](structure.md) | Where a file goes, the library tags, the import rule, the generator for a new library. |
| [System refactoring plan](refactoring.md) | The ordered refactoring of the code base by responsibility, how each step is verified, and the evidence recorded for the steps done. |
| [Design system](design-system.md) | The tokens, type, spacing, layout and component inventory of the app. |
| [Plugins](plugins.md) | The event contract a pi package uses to talk to pi-kit. |
| [Decision records](adr/README.md) | One record per decision, numbered, with the reasoning and what was verified. |

## Beside the pages

- `doc/api/openapi.yaml`: the backend's HTTP contract, regenerated from the code by `pnpm run api:openapi`.
- The source itself: every exported class carries a TSDoc block that says what it is for, and the libraries' `README.md` files say what each holds.

## Working on the site

```bash
cd doc
pnpm install
pnpm start      # live preview on http://localhost:3000/pi-kit/
pnpm build      # the static site in doc/build/
```

The site is a package of its own, outside the Nx workspace: its React and webpack never land in the app's hoisted `node_modules`.
Pages are CommonMark `.md` files; a page that needs components is `.mdx`. Diagrams are Mermaid code blocks.
