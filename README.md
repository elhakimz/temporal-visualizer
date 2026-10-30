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

## Parent, child and continued runs

Workflows rarely live alone. The visualizer follows the links in the history, so you can move between related runs
without going back to the list. Everything below is hidden for the built-in sample.

**Child workflows**

- A child workflow step has an **Open child** button in its details (it is disabled until the child has started), and
  you can also **double-click the step**. **Open in Temporal UI** opens the same child in the Temporal Web UI.
- With nothing selected, the side panel lists **Child workflows (N)** with their state: click a row to find the step on
  the canvas, or **Open** to go into the child.
- On the Failures tab, a failed child has **Open child to see why it failed**: the real cause is in the child's own history.

**Back to parent**

- A run that was started by a parent shows **↑ Back to parent** under the title. It opens the parent and selects the step
  that started this child, so you land in context (a parent that has been continued as new is found by its exact run).
- The **breadcrumb** next to it shows every ancestor, root first (`OrderWorkflow › ShipFlow › LabelFlow`); click any of
  them to jump there, again landing on the step that leads towards where you were. Ancestors are read from the first
  event of each run (one small request each, cached) and the trail is capped at 8 levels.

**Continue-as-new, retries and cron**

- A run that continued from another shows **← Previous run**; one that handed over to another shows **→ Next run**
  and **⇥ Latest run**. This covers continue-as-new, workflow retries and cron schedules; the button tooltips say which.
- **Latest run** asks the server for the newest run of that workflow ID, so it also works when the chain is long.
  If you are already on it you get a short notice instead.
- The end step of a continued run has **Open next run**, and double-clicking it follows the chain too.

**Browser history.** Every navigation is part of the page URL (`#workflowId/runId`, plus `?node=` for the step to select
and `?ns=` for another namespace), so the browser's **Back** and **Forward** buttons walk through the runs you opened,
and a link to a child or to a step inside a run can be shared. Children in another namespace are opened in theirs.

The relations are read in `src/core/lineage.ts` (covered by `npm test`, including a grandchild and a three-run
continue-as-new chain from `npm run fixture:family`; the mock server serves them as `order-P-7000` and `poller-Q-8000`).

## Failure triage

The side panel has two tabs, **Details** and **Failures**. The Failures tab carries a count badge, and a
"Review N failures" shortcut appears in the Details tab when nothing is selected.

**What counts as a failure**

- an activity, local activity, child workflow or update that failed or timed out
- an activity that failed an attempt and is still being retried (shown as *retrying*; once it eventually completes it is
  no longer a failure, and if it runs out of attempts it becomes *failed*)
- a workflow task that failed or timed out (for example a non-determinism error). These are not tied to a step, so
  they expand inline instead of jumping
- a workflow failure that only wraps one of the above is listed once: it is kept on the end node's details but not
  counted again

**Grouping.** *By type* groups by the root cause's type (the Java exception class, "Timeout (start to close)", ...) and
shows an example message. *By message* groups by message with numbers, UUIDs and hex ids masked, so
"balance 12.50 is below 129.90" and "balance 3.20 is below 55.00" land in one group. The biggest groups come first and
the two biggest start open. **Copy as text** puts a summary of the groups on the clipboard for a ticket or chat.

**Jump to the failing step.** Click an occurrence: the step is selected and centred on the canvas, outlined, and the
Details tab opens on it. If the replay scrubber is rewound to before that failure, it moves forward to the failing
moment first. The arrow at the end of a row expands the full failure in place without leaving the list.

**Failure details** (Details tab, for a failing step, and inline in the list):

- the root cause first: type, message and **full stack trace**
- the wrapping failures (for example `ActivityFailure` with the activity name, id and retry state, or
  `ChildWorkflowFailure`) folded under "Wrapped by N failures", each with its own trace
- stack frames from the JDK, the Temporal SDK and dependencies (`java.*`, `io.temporal.*`, `node_modules`,
  `site-packages`, ...) are greyed and your own frames are bold; **Hide framework frames** collapses the grey ones
- non-retryable failures are tagged, and failures whose message and stack were encrypted by a failure converter are
  decoded when they use the default JSON encoding
- **Copy** buttons copy one stack trace, or the whole failure (outcome, cause chain and every stack) as plain text

**IDs and links**

- the workflow ID and run ID are chips under the title: click to copy. Activity, timer, child workflow and run IDs in the
  details have a copy icon too
- **Open in Temporal UI** (top right) opens the run's history page in a new tab, and a child workflow step has
  **Open child in Temporal UI**. The link goes to the same server the dev proxy points at (`TEMPORAL_UI`). If your browser
  reaches the UI at a different address than the proxy does (for example a container name), set
  `TEMPORAL_UI_PUBLIC=http://localhost:8233`. The link is hidden for the built-in sample

The logic is in `src/core/failure.ts` (parsing, grouping, stack classification, text export) and is covered by
`npm test` with a fixture of many failure kinds (`npm run fixture:failing`; the mock server serves it as `order-F-6001`).

## Replay scrubber

Once a run has finished (or while you look at a run that has just closed), a control bar appears under the graph.
It starts at the final state; move it back to see the run as it unfolded.

- **Steps, not raw events.** A step is an event that changes what the graph shows (activity scheduled, started,
  completed, timer fired, signal received, ...). Workflow-task bookkeeping is skipped, so every step changes something.
  Workflow-task failures stay in as steps. A 45-event history is typically about 20 steps.
- **The track.** Each tick is a step, coloured by outcome (red failures, green completions, blue signals). Drag the
  playhead, click anywhere on the track, or hover for a tooltip with the time offset and what happened.
- **Keyboard** (focus the track): Left/Right = one step, Shift or PageUp/PageDown = ten, Home/End = first/last,
  Space = play or pause.
- **Play** runs through the steps; the speed button cycles 1x, 2x, 4x, 0.5x. Pressing play at the end restarts from
  the beginning.
- **Time scale** spaces the ticks by real time instead of evenly, so gaps (a 5 s sleep, a slow activity) are visible,
  and playback waits in proportion (long runs are compressed to about 24 s at 1x).
- **Timeline** in the side panel (when no node is selected) lists every step with its offset. Click a row to jump to it;
  steps still to come are dimmed. Selecting a node still shows the details of that node *at the chosen moment*.
- Node positions stay where they are while you scrub, so you can follow one node through the run.
- **Final state** jumps back to the end.

The logic lives in `src/core/timeline.ts` (step building, positions, playback timing; covered by `npm test`) and the
controls in `src/scrubber.ts`.

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
  new nodes slide out of their parent. The view follows the newest step while "Follow live" is on.
- **Recent changes** in the side panel lists every transition with a time stamp.
- **Transport:** the feed long-polls `.../history?waitNewEvent=true`, so new events arrive as soon as the
  server has them. If the server answers immediately without events, or the route is missing, it switches
  to polling once a second; the indicator in the top bar says which mode is active.
  Retry counts are not events, so `describe` is refreshed every 1.5 s while the workflow runs.
- Untick **Follow live** to freeze the picture; tick it again to catch up.

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
                         # fake UI API on :8234: a finished run (order-A-1042), a live long-polling one (order-B-2210),
                         # many failures (order-F-6001), a parent with children and a grandchild (order-P-7000)
                         # and a continue-as-new chain (poller-Q-8000)
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
