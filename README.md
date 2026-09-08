# TaskIndex

A workspace for tasks, projects, and follow-ups.

TaskIndex keeps agency operations, development projects, and personal tasks in
separate areas, with clear priorities, waiting states, and the next action.

## Application

This repository contains a copy of the Codex implementation: React, TypeScript,
Vinext, and Cloudflare D1. The existing Russian interface and behavior are
preserved, including its current display name, «Пространство».

- Board and list views with area and project navigation.
- Tasks with notes, checklists, due dates, waiting contacts, and follow-up dates.
- Drag-and-drop ordering, completion, reversible archiving, and undo.
- Project creation and renaming, search within the selected context.
- Server validation, record revisions, and conflict recovery that preserves drafts.
- Optional WebMCP actions through the same task operations.

## Development

Requires Node.js 22.13 or later and npm.

```sh
npm ci
npm run dev
```

The application uses the local `DB` D1 binding configured in `vite.config.ts`.
On a fresh checkout, apply the migrations in `drizzle/` to that local binding
before first use. Runtime handlers do not create or alter tables.

```sh
npx tsc --noEmit
npm run build
```

`scripts/verify-api.mjs` checks a running local API, including persistence,
concurrent edits, validation, and archive state. It creates test records, so run
it against a disposable local database.

## Data and hosting

The local working copy received a consistent snapshot of the prototype's D1
database. This includes the previously populated tasks and projects. That
snapshot stays in ignored `.wrangler/state/`; it is not included in Git.

The source's sample seed remains illustrative. A fresh database is separate
from the populated local snapshot. The application does not write to /OS,
Telegram, hiring pipelines, or financial records.

`.openai/hosting.json` retains the original Sites project configuration. Copying
this repository does not create or deploy a separate hosted site. The application
relies on the hosting access controls and does not implement per-user tenancy.

## Provenance

Copied on 2026-09-08 from `../os-tools/gosling-space/`, commit
`37799eea730f74323707bd0dee0b8d489a007d26`. The original checkout remains separate.

The Fable alternative is at
`../../fansly/agent-reviews/panels/2026-09-07-kanban-board/board.html`.
These are local filesystem paths relative to this checkout, not hosted links.
