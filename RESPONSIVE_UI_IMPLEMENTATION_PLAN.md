# Responsive UI Implementation Plan (Mobile / Tablet / Desktop)

## Goal

Make the application usable and predictable on:

- mobile (phone)
- tablet
- desktop

while preserving current desktop workflows (code editor + graph + kanban + history + drag/drop).

## Scope

This plan covers frontend responsive layout and interaction behavior only.

- In scope: layout, breakpoints, mode switching, touch-safe UI, history panel responsiveness, modal responsiveness, performance optimizations for hidden panes.
- Out of scope: backend API changes, feature redesigns unrelated to viewport behavior.

## Current App Constraints (Repo-Specific)

- Split-pane layout is desktop-first (`editor-panel` + graph/kanban area).
- `frontend/scripts/app.ts` still orchestrates most UI state.
- `frontend/scripts/canvas.ts` and `frontend/scripts/kanban.ts` depend on pointer precision and drag/drop.
- History UI is a floating bottom panel with slider/marks and a top-center viewer banner.
- History viewer mode already disables editing/drag-drop and sets editor read-only.

## Responsive Principles

1. Preserve desktop behavior by default.
2. Do not rely on hover for critical actions on touch devices.
3. Prefer explicit pane switching on smaller screens over cramped split panes.
4. Keep controls reachable with 40px+ tap targets on mobile.
5. Defer behavior changes until layout changes are stable (CSS-first where possible).
6. Gate advanced interactions by viewport/touch capability, not only width.

## Breakpoint Strategy

Use both CSS breakpoints and runtime viewport mode state.

- `desktop`: `>= 1200px`
- `tablet`: `768px - 1199px`
- `mobile`: `< 768px`

Height adaptation:

- `compact-height`: viewport height `< 700px` (especially mobile landscape)

Runtime dataset flags on `<html>`:

- `data-viewport="desktop|tablet|mobile"`
- `data-viewport-height="compact|regular"`

## Target Behavior by Viewport

### Desktop

- Keep current split panes and dividers.
- Keep graph + kanban behavior unchanged.
- Full toolbar and search controls visible.

### Tablet

- Two-pane layout:
  - left: editor
  - right: graph or kanban (toggle)
- Hide/minimize non-critical graph chrome (legend/minimap) by default.
- Condense toolbar labels; preserve main actions.

### Mobile

- Single-pane mode with tabs:
  - `Code`
  - `Graph`
  - `Kanban`
  - `History`
- No draggable split panes.
- Touch-first controls (larger targets, stacked layouts).
- Drag/drop may be disabled or replaced with explicit actions where precision is poor.

## Execution Strategy

- Implement in small batches.
- Each batch should preserve existing behavior outside its viewport scope.
- Prefer adding state hooks + CSS before changing interaction models.
- Run tests after each batch (see validation section).

## Batches

## Batch 1: Viewport State + Dataset Flags (Non-Visual)

### Tasks

- Add viewport mode calculation in `frontend/scripts/app.ts`.
- Add compact-height calculation.
- Update on window resize.
- Reflect flags on `<html>` dataset.
- Add a small helper (`updateViewportMode()`), used from existing layout recalculation paths.

### Done When

- Resizing updates `<html data-viewport>` and `<html data-viewport-height>` live.
- No visual regressions introduced.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/app.contract.unit.test.js tests/styles.contract.unit.test.js`

## Batch 2: Topbar Responsive Layout (CSS-First)

### Tasks

- Make topbar wrap/stack cleanly on narrow widths.
- Ensure board title + search + toolbar do not overlap.
- Reduce padding/gaps on tablet/mobile.
- Preserve search usability (full-width on mobile).
- Ensure history viewer banner positioning still works when topbar layout changes.

### Done When

- No clipped controls or overlap at common widths (`360`, `390`, `768`, `1024`, `1366`).
- Search bar stays usable.

### Validation

- `node --loader tsx --test tests/styles.contract.unit.test.js`
- manual resize check

## Batch 3: Toolbar Condensation + Priority Actions

### Tasks

- Condense toolbar buttons on tablet/mobile:
  - hide text labels where icons are sufficient
  - keep `aria-label`s
- Keep critical actions always visible:
  - add task
  - history
  - connect/login (if shown)
  - save/load as applicable
- Introduce an overflow menu placeholder/hook (optional in this batch, functional later).

### Done When

- Toolbar remains usable on tablet/mobile without excessive wrapping.
- Buttons remain tappable.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/styles.contract.unit.test.js tests/app.contract.unit.test.js`

## Batch 4: Responsive History Panel + Banner

### Tasks

- Convert history panel into a responsive bottom sheet on mobile.
- Ensure slider, step buttons, marks, and action buttons fit without clipping.
- Stack or wrap action rows on mobile.
- Ensure top history banner and board subtitle (`History - read only`) remain readable and non-overlapping.
- Add touch-friendly tooltip fallback for history marks if needed (tap-only visible label is acceptable v1).

### Done When

- History panel is usable on phone widths.
- Revert/Cancel/Tag remain visible and reachable.
- Time-scaled marks remain aligned with slider min/max positions.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/app.contract.unit.test.js tests/styles.contract.unit.test.js`

## Batch 5: Mobile Single-Pane Navigation (Tabs)

### Tasks

- Add mobile-only tab row (`Code`, `Graph`, `Kanban`, `History`).
- Add app state for active mobile pane.
- Hide/show main panes based on active tab.
- Disable split dividers on mobile.
- Keep hidden panes mounted if necessary to avoid state loss (initially).

### Done When

- Mobile shows exactly one main pane at a time.
- Switching tabs preserves current content/state.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/app.contract.unit.test.js tests/styles.contract.unit.test.js`

## Batch 6: Tablet Two-Pane Visualization Toggle

### Tasks

- Add tablet-only toggle for right pane (`Graph` / `Kanban`).
- Hide inactive visualization panel.
- Default to last-used view (persist locally if trivial).
- Hide/minimize graph legend/minimap by default on tablet.

### Done When

- Tablet has stable editor + one visualization panel layout.
- Desktop remains unchanged.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/app.contract.unit.test.js tests/canvas.unit.test.js tests/kanban.unit.test.js tests/styles.contract.unit.test.js`

## Batch 7: Modal Responsiveness (Full-Screen Sheets on Mobile)

### Tasks

- Make larger modals mobile-friendly (full-screen or near-full-screen sheets):
  - task edit/create
  - spaces/folders management
  - slug rename
  - history tag modal
- Add sticky action rows if needed.
- Increase form field spacing and tap targets.
- Ensure keyboard focus/scroll works with mobile viewport heights.

### Done When

- Modals are fully usable at mobile sizes without clipped actions.
- Focus trap/close behavior still works.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/app.contract.unit.test.js tests/styles.contract.unit.test.js`

## Batch 8: Graph Responsive Interaction Policy (Touch-Safe)

### Tasks

- Define and implement graph behavior by device class:
  - desktop: current drag/reparent/reorder behavior
  - tablet/mobile: reduce precision-heavy interactions as needed
- Add touch guards for unsupported graph drag/drop operations.
- Provide explicit fallback actions where drag becomes unreliable (initially minimal, e.g. action buttons/menu hooks).
- Tune graph UI density for smaller widths (node padding, controls, search bar width interaction).

### Done When

- Graph is usable on tablet/mobile without accidental drag conflicts.
- No broken hover-only actions on touch.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/canvas.unit.test.js tests/styles.contract.unit.test.js tests/app.contract.unit.test.js`

## Batch 9: Kanban Mobile/Tablet Improvements

### Tasks

- Improve lane/card layout on smaller widths:
  - horizontal lane scroll
  - sticky lane headers
  - spacing and tap targets
- Review kanban drag/drop on touch; disable or guard where unreliable.
- Provide explicit state-change actions fallback if needed (v1 can be simple).
- Ensure full-description mode (graph hidden / graph-top hidden) remains readable on mobile.

### Done When

- Kanban remains readable and usable on phone/tablet.
- No clipped card content or unreachable controls.

### Validation

- `npm run typecheck`
- `node --loader tsx --test tests/kanban.unit.test.js tests/styles.contract.unit.test.js tests/app.contract.unit.test.js`

## Batch 10: Hidden-Panel Render Optimization (Interaction Responsiveness)

### Tasks

- Avoid heavy rerenders/layout work for hidden panes in:
  - mobile tab mode
  - tablet visualization toggle mode
- Throttle/debounce resize-triggered layout recomputation.
- Skip graph redraw/layout when graph pane is hidden.
- Skip kanban rebuilds when kanban pane is hidden (where safe).

### Done When

- Tab switching and resize feel responsive on lower-powered devices.
- No stale UI state after pane switches.

### Validation

- `npm run typecheck`
- `npm run test:unit`
- manual stress test (resize + pane switching + history mode)

## Batch 11: Polish + Documentation

### Tasks

- Tune spacing/typography at breakpoints.
- Audit history banner, board subtitle, search bar alignment across breakpoints.
- Ensure buttons and labels remain readable in compact-height mode.
- Update `USAGE.md` with responsive behavior notes and limitations.
- Add/adjust contract tests for any new responsive hooks/dataset attributes.

### Done When

- Core flows work on mobile/tablet/desktop:
  - edit code
  - graph view
  - kanban view
  - history panel/viewer mode
  - modals
- Responsive behavior is documented.

### Validation

- `npm run typecheck`
- `npm run test:unit`
- `npm run build:dist`

## Test Matrix (Manual Smoke)

Run these after Batches 5-11:

- Mobile portrait (`360x800`)
  - switch tabs, open history panel, preview checkpoint, cancel, tag point
- Mobile landscape (`800x360`)
  - compact-height layout sanity
- Tablet (`820x1180`)
  - editor + graph/kanban toggle, history panel, modal open/close
- Desktop (`1366x768`)
  - regression check for split panes, graph drag/drop, history viewer mode

## Risks / Known Tradeoffs

- Desktop drag behaviors are precision-based; mobile parity is not required in v1.
- Hidden-pane optimizations can cause stale renders if gating conditions are too aggressive.
- History panel/timeline has dense controls; mobile UX may require stronger simplification than CSS-only changes.
- Touch vs pointer detection can differ on hybrid devices; prefer capability checks plus viewport rules.

## Suggested Execution Order

1. Batches 1-4 (foundations + topbar/history)
2. Batches 5-6 (mobile/tablet pane behavior)
3. Batch 7 (modals)
4. Batches 8-9 (graph/kanban touch policy)
5. Batch 10 (performance)
6. Batch 11 (polish + docs)

## Stop Conditions (for unattended execution)

Stop and checkpoint if any of these happen:

- unit tests fail outside the current batch scope
- desktop interactions regress (graph drag/reorder, history viewer mode, editor save/format)
- topbar/history panel overlap appears in desktop widths
- responsive change requires product decision (e.g. disable drag on tablet vs mobile only)

