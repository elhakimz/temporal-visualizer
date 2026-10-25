# Temporal workflow visualizer

Shows a Temporal workflow execution as a node graph, drawn with the
[`@comfyorg/litegraph`](https://github.com/Comfy-Org/litegraph.js) fork of LiteGraph.
It reads the event history of any workflow, so it works with the Java SDK
(or any other SDK) and needs no changes to your workers.

## Run it

```bash
temporal server start-dev        # your existing dev server: gRPC 7233, UI/HTTP 8233
npm install
npm run dev                      # opens http://localhost:5173
```

The browser cannot speak gRPC, so the app calls the HTTP API served by the Temporal UI
(port 8233) through Vite's dev proxy. If your UI runs elsewhere:

```bash
TEMPORAL_UI=http://my-host:8233 npm run dev
```

Pick a workflow on the left. A link such as `http://localhost:5173/#<workflowId>/<runId>`
reopens the same run. **Replay sample** plays a recorded history back as a live run, without a server.

## Resizing and collapsing the sidebar

- Drag the thin handle on the sidebar's right edge to resize it. The width is limited to between 260 px and
  45 % of the window (`MAX_RATIO` in `src/core/sidebar-size.ts`). Double-click the handle to reset to 340 px.
- The handle is also reachable by keyboard: focus it, then use Left/Right (Shift for bigger steps), Home and End.
- The chevron next to "Workflows" collapses the list to a narrow rail. The rail shows the number of failed
  workflows and a dot when a new workflow arrives while it is collapsed; the dot clears when you expand.
- Width and collapsed state are remembered in the browser (`localStorage`), and the width is re-clamped when
  the window shrinks.

## Filtering the workflow list

Chips above the list narrow it down. They combine (AND), except where two chips are opposites:

| Chip | Shows |
|---|---|
| All | everything; clears the other chips |
| Failures (count) | runs that failed or timed out; terminated runs are not counted. The badge shows how many a click would show, given the other chips. The icon is a smile at 0 and a frown otherwise |
| Running | runs that are still open (replaces Failures, and the other way round) |
| Parent | top-level workflows only; child workflows are hidden |
| Today | started after local midnight (replaces Last 1h) |
| Last 1h | started in the last hour |

Filters apply to the loaded list (up to 100 runs from the visibility query). The list reloads in the
background every 5 s, so Running, Failures and Last 1h stay current. The visibility query box still narrows
what is loaded on the server side.

### New workflows appear by themselves

The list reloads every 2 s (and at once when you return to the tab). A run that was not in the previous
listing is treated as new:

- its row blinks three times (about 3.6 s) and keeps a **New** tag for 30 s; a re-render in the middle of the
  blink continues it instead of restarting it
- a row whose status changed (for example Running to Completed) gets one short yellow flash
- if a new run is hidden by the active chips, or sits above the part of the list you scrolled to, a notice at
  the top of the list says so, with **Show all** or **Jump to top**
- screen readers are told "New workflow started: …"
- with reduced-motion enabled in the OS, the blink becomes a steady highlight

The first load, and any change of namespace or visibility query, only sets the baseline, so nothing blinks then.
Keyboard focus stays on the row you were on while the list refreshes.

## Live updates

Opening a workflow starts a *feed* (`src/feed.ts`) that follows the run and emits typed events
(`snapshot`, `update` with a node/edge diff, `mode`, `closed`, `error`). The canvas and the side panel
are just subscribers, so nothing re-renders from scratch:

- **State-only changes** (running, retrying, completed, failed, attempt count) edit the existing node in
  place and outline it for about 1.5 s.
- **New steps or links** rebuild the graph but keep every node where it is (including nodes you dragged);
  new nodes slide out of their parent. The view follows the newest step while "Follow live updates" is on.
- **Recent changes** in the side panel lists every transition with a time stamp.
- **Transport:** the feed long-polls `.../history?waitNewEvent=true`, so new events arrive as soon as the
  server has them. If the server answers immediately without events, or the route is missing, it switches
  to polling once a second; the indicator in the top bar says which mode is active.
  Retry counts are not events, so `describe` is refreshed every 1.5 s while the workflow runs.
- Untick **Follow live updates** to freeze the picture; tick it again to catch up.

To subscribe from your own code:

```ts
const feed = new WorkflowFeed(new TemporalApi('default'), workflowId, runId);
feed.subscribe((e) => { if (e.type === 'update') console.log(e.messages); });
feed.start();
```

## What you see

| Shape | Meaning | Comes from |
|---|---|---|
| Thin circle | Workflow started | first event |
| Thick circle | Workflow ended (colour tells how: completed, failed, timed out, canceled) | closing event |
| Rounded rectangle | Activity | `ActivityTask*` events (attempt count from the started event and the pending-activity list) |
| Dashed rounded rectangle | Local activity | `MarkerRecorded` with marker name `LocalActivity` |
| Rounded rectangle inside a second outline | Child workflow (sub-workflow) | `StartChildWorkflowExecution*` / `ChildWorkflowExecution*` |
| Small rectangle, rounded on the right | Signal or update received | `WorkflowExecutionSignaled`, `WorkflowExecutionUpdateAccepted` |
| Double circle with a clock | Timer | `Workflow.sleep`, `Workflow.await` with timeout |

Arrowheads show the direction of flow, and the links of the selected node turn blue.

Node colour is the state: scheduled, running, retrying, completed, failed, timed out, canceled.
Click a node for timings, decoded JSON input/result, the failure cause and its history events.
Workflow task failures and timeouts (for example non-determinism errors) appear as warnings
in the side panel when nothing is selected.

## How edges are inferred

History does not say which result a command depended on. The graph uses this rule:
everything that finished since the previous batch of commands (activity done, timer fired,
child closed, signal received) is a parent of the commands the next workflow task issues.
That is exact for sequential code and for fork/join code (`Async.function` followed by
`Promise.get`). It can over-connect when unrelated work runs concurrently, and local
activities issued in the same task are shown as a chain.

## Checks

```bash
npm test                 # parser, diff and layout checks against a generated Java-style history
npm run sample           # regenerate src/sample-history.json
SPAWN_MS=9000 node scripts/mock-temporal-ui.mjs   # SPAWN_MS starts a new workflow that often
                         # fake UI API on :8234 with one finished and one live, long-polling workflow
                         # (TEMPORAL_UI=http://localhost:8234 npm run dev)
```

## Notes

- API paths used: `/api/v1/namespaces/{ns}/workflows` (list), `.../workflows/{id}/runs/{run}/events`
  with a fallback to `.../history`, and `.../workflows/{id}/runs/{run}` (describe).
  Enum names are accepted in both `EVENT_TYPE_X` and `X` styles.
- The dev server keeps history in memory, so restarting it clears the list.
- `@comfyorg/litegraph` is archived; pin its version (it is pinned by `package-lock.json`).
- Shapes are drawn in `src/render.ts` (`shapePath`, `onDrawBackground`, `onDrawForeground`): LiteGraph only fills an
  invisible box behind each node, so any outline can be painted on top.
- Check the licence of the LiteGraph code you ship before using this in a product.
