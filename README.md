# Temporal Workflow Visualizer

A browser-based viewer that draws Temporal workflow executions as a live node graph.

## Why this exists

Temporal workflows are code. A workflow with parallel branches, retries, timers, signals
and child workflows is hard to picture from the event list alone, and harder still to explain to
someone who did not write it. This tool turns a workflow's event history into a graph you can
read at a glance and watch while it runs.

It reads history from the Temporal server, so it works with workflows written in any SDK
(Java, Go, TypeScript, Python, .NET) and needs no changes to your workers or workflow code.

## What it does

- **Draws each run as a graph.** Activities, local activities, timers, child workflows, signals
  and updates are nodes, coloured by state: scheduled, running, retrying, completed, failed,
  timed out, canceled.
- **Updates live.** New steps and state changes appear as they happen, without a page refresh.
  Changed nodes are outlined briefly, and a change log lists every transition.
- **Shows what went wrong.** Click a node for timings, attempt count, the decoded JSON
  input and result, the failure cause and its history events. Workflow task failures
  (for example non-determinism errors) are shown as warnings.
- **Keeps a live workflow list.** Filter by failures, running, top-level workflows, today
  or the last hour. New workflows blink when they start, so you notice them straight away.
- **Works without a server.** A built-in sample replays a recorded history as a live run.

## Who it is for

- Developers building and debugging Temporal workflows who want to see execution flow,
  retries and failures rather than read raw events.
- Teams who need to explain or review a workflow's behaviour with people who do not read
  workflow code.

