# TaskIndex interface exploration — 2026-09-08

The owner requested three independent alternative visions of the task manager
and one conservative improvement of the existing interface. These are populated
homepage prototypes for visual comparison, not an accepted replacement or a
complete application.

Open `/visions/index.html` on the local development server. The switcher also
offers the original interface screenshot, a narrow preview, and a short rationale
and tradeoff for each direction. Each prototype can be opened separately.

| Direction | Main unit of work | Why it may fit |
| --- | --- | --- |
| Focus | One current action and a short next queue | Starting a bounded task and resuming after a context switch |
| Dispatch | Decisions and replies | Seeing where the owner is holding up delegated work |
| Atlas | Project, next outcome, and point of intervention | Recovering the overall picture across agency and engineering |
| Evolution | Existing project navigation and status board | Better card hierarchy and context with a familiar structure |

## Shared context

The brief covers agency content production, hiring, chatters and traffic,
alongside Hub, ChatGoose, ContentOps, tg-assistant and other development projects.
It emphasizes a concrete next action, owner decisions, waiting contact and return
date, completed work and parked work. Personal work remains separate.

Example task titles are adapted from the existing local TaskIndex snapshot.
The visible priorities, dates, estimates, checklists and statuses are illustrative
scenarios anchored to 8 September 2026, not a live operational audit. The baseline
screenshot records the existing local interface on that date.

## Scope

- Each agent authors a separate self-contained HTML artifact with embedded CSS,
  JavaScript and sample data. The coordinating agent integrates and checks them.
- Interactions demonstrate selection, filtering and task context in memory.
  Reloading resets the examples. There are no connector calls or writes to the
  workspace database or external operational systems.
- The application at `/`, its navigation, existing task operations, persistence,
  dependencies and hosting configuration are preserved.
- This comparison does not supersede the accepted sidebar decision in
  `BACKLOG.md`. A later owner selection determines any product implementation.

Artifacts: `public/visions/`. Run with the existing `npm run dev` command or serve
that directory as static files. No external fonts or image services are required.

## Validation

The four homepages were visually inspected in the local browser at desktop and
390px iframe widths. Representative checks covered task/project selection,
filters, search and task details, local checklist changes, and the comparison
controls. Atlas's parked/completed sections were corrected to respect its area
filter. All inline scripts parse; `npm run build` and `git diff --check` passed.
The workspace API response before and after the preview checks is identical.

The prototypes are bounded demonstrations; this is not a full application or an
exhaustive interaction/accessibility test. Agent rationales are saved alongside
this document in `interface-visions/`.
