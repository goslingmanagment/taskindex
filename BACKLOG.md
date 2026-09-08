# TaskIndex backlog

## Interface decision — 2026-09-08

Keep the existing sidebar: «Все задачи» followed by the area's projects with
colored dots (for example Hub, ChatGoose, ContentOps, tg-assistant, psyflow).
The owner reaffirmed this layout with a screenshot. The existing status board
and project filtering stay in place; the proposal to replace them with columns
by direction/project is withdrawn.

The earlier preference for «Просторно» concerned density in the comparison
mockup only. It did not approve replacing the sidebar or a broader redesign.
Global search and Focus remain approved. Structured card history remains a
separate proposal awaiting a decision.

## Later — full AI access and context

Owner request, 2026-09-08: every part of TaskIndex must be available to an AI
agent with enough context to work correctly. Deliberately deferred; this is a
product requirement, not a decision to add a specific SDK, protocol, or service.

- One source of truth and the same operations for the owner and agent. The agent
  can discover and read every supported entity, field, relationship, view and
  action: areas, projects, tasks, status/order, Focus, dates, waiting contacts,
  checklists, archives, and future history, links, attachments and settings.
- Context must explain the data model and meaning of fields, current selection,
  task relationships, current state versus history, sources and their freshness,
  unknowns, pending edits, conflicts and the next action. Search and exports must
  be complete or explicitly paginated, never silently truncated.
- Support reading, searching, creating, editing, moving, completing, archiving,
  restoring and all future user operations through a documented, discoverable
  interface. Access parity is a requirement for each future feature.
- Use stable identifiers, validated input, idempotent retries, record revisions,
  safe conflict resolution and attribution for human/agent changes. Independent
  history events must not overwrite concurrent entries.
- The board reflects agent changes while preserving open owner drafts. The agent
  receives actionable results, including current records on conflicts, rather
  than an ambiguous success message. Imports/exports retain all supported data.
- Define explicit authorization and confirmation for consequential operations.
  Full application access does not automatically authorize sending messages,
  payments, production changes or writes to connected operational systems.
- Before implementation, choose the simplest transport and context contract with
  a worked human/agent scenario and an end-to-end capability coverage check.
  Existing WebMCP is partial; do not present it as fulfilling this requirement.

## Awaiting visual review

- A compact current summary and next step with expandable dated history and
  source links. Show the same example before and after before changing the editor.

## Consider later

- Optimistic edits with safe rollback. Dragging and a server-backed Undo action
  already exist; do not list them as missing features.
- Address the 20 existing full-repository lint errors in template components,
  `hooks/use-mobile.ts` and the old API check script. Changed-file lint passes.
