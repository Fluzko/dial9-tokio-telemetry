// Pure derivations for the Task tab's flamegraph: which CPU samples belong to
// the selected task, and which belong to every task sharing its spawn location.
// No store, no DOM - inspector.ts owns the widget lifecycle and renders from
// these.
//
// The two scopes read DIFFERENT sources on purpose:
//
//   - "task" walks the selected task's own polls, whose `cpuSamples` the lane
//     reconstruction already attached. The Task tab holds those polls anyway,
//     so this costs nothing beyond a concat.
//
//   - "spawn-location" reads `sample.spawnLoc`, which `attachCpuSamples` stamps
//     on every sample from the poll it landed in. Walking the lanes instead
//     would materialize a poll flyweight per poll in the trace - millions on a
//     large one - to reach data the samples already carry.
//
// Everything here reads the trace's own task maps. Nothing reaches for
// taskIndexFor: that builds the whole task index (worker spans + per-task
// aggregates), and the lanes call into this file from a paint frame.

import { isFoldableCpuSample } from "./region-analysis-model.js";
import type { CpuSample, ParsedTrace, PollSpan } from "../../lib/trace/index.js";

/**
 * What the Task tab is looking at. Drives BOTH surfaces: the lanes tint every
 * sibling task's polls, and the flamegraph folds their samples.
 */
export type TaskScope = "task" | "spawn-location";

export const TASK_SCOPES: readonly TaskScope[] = [
  "task",
  "spawn-location",
];

/** Validate a scope arriving from the DOM or a URL before it reaches the store. */
export function parseTaskScope(value: string): TaskScope | null {
  return (TASK_SCOPES as readonly string[]).includes(value)
    ? (value as TaskScope)
    : null;
}

/** The scope switch's button label. */
export function scopeLabel(scope: TaskScope): string {
  return scope === "task" ? "This task" : "All from spawn";
}

/** What the Task tab renders for one (task, scope) pair. */
export interface TaskFlamegraphView {
  scope: TaskScope;
  /** Foldable on-CPU samples, in trace order. Empty means nothing to draw. */
  samples: readonly CpuSample[];
  /** How many tasks contributed - 1 for the "task" scope, the whole spawn
   *  location's task count for the other. */
  taskCount: number;
  /** Title for the flamegraph's export/header. */
  title: string;
}

const EMPTY_SAMPLES: readonly CpuSample[] = [];

/** The selected task's own on-CPU samples, gathered from its polls. */
export function taskCpuSamples(polls: readonly PollSpan[]): CpuSample[] {
  const out: CpuSample[] = [];
  for (const poll of polls) {
    const samples = poll.cpuSamples;
    if (samples === undefined) continue;
    for (const s of samples) {
      if (isFoldableCpuSample(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Every on-CPU sample taken inside a poll of a task spawned at `location`.
 *
 * `attachCpuSamples` writes each sample's `spawnLoc` from its enclosing poll's
 * RESOLVED location (trace_analysis.js: `sample.spawnLoc = poll.spawnLoc`), not
 * from an id - so this compares strings directly and stays correct whatever
 * `spawnLocations` keys its entries by. Samples outside any poll carry a null
 * `spawnLoc` and are skipped.
 */
export function spawnLocationCpuSamples(
  trace: ParsedTrace,
  location: string,
): CpuSample[] {
  const out: CpuSample[] = [];
  for (const s of trace.cpuSamples) {
    if (s.spawnLoc !== location) continue;
    if (isFoldableCpuSample(s)) out.push(s);
  }
  return out;
}

/** How many tasks in the trace were spawned at `location`. */
export function tasksAtSpawnLocation(trace: ParsedTrace, location: string): number {
  return taskIdsAtSpawnLocation(trace, location).size;
}

/**
 * The spawn location recorded for a task, or null when the trace has none.
 *
 * Reads the task maps rather than a poll's `spawnLocId`, so a caller that has
 * only a task id (the lanes) resolves the SAME string the Task tab shows. The
 * single seam for that resolve: wakerLabelFor and taskIndexFor call it too.
 */
export function spawnLocationOf(
  trace: Pick<ParsedTrace, "taskSpawnLocs" | "spawnLocations">,
  taskId: number,
): string | null {
  const locId = trace.taskSpawnLocs.get(taskId);
  if (locId == null) return null;
  return trace.spawnLocations.get(locId) ?? null;
}

const EMPTY_TASK_IDS: ReadonlySet<number> = new Set();
const scopeSetCache = new WeakMap<ParsedTrace, Map<string, ReadonlySet<number>>>();

/**
 * Every task in the trace spawned at `location`.
 *
 * Scans `taskSpawnLocs`, which the parser fills from BOTH TaskSpawn and the
 * first PollStart of a task - the same union taskIndexFor's rows cover - so this
 * is the whole sibling set without building that index. Memoized per (trace,
 * location): the lanes ask for this on every frame.
 */
export function taskIdsAtSpawnLocation(
  trace: ParsedTrace,
  location: string,
): ReadonlySet<number> {
  let byLocation = scopeSetCache.get(trace);
  if (byLocation === undefined) {
    byLocation = new Map();
    scopeSetCache.set(trace, byLocation);
  }
  const cached = byLocation.get(location);
  if (cached !== undefined) return cached;
  const ids = new Set<number>();
  for (const taskId of trace.taskSpawnLocs.keys()) {
    if (spawnLocationOf(trace, taskId) === location) ids.add(taskId);
  }
  byLocation.set(location, ids);
  return ids;
}

/**
 * The sibling set the lanes tint: every task sharing the selected task's spawn
 * location. Empty for the "task" scope, for no selection, and for a task whose
 * spawn location the trace never recorded - all three mean "nothing to group
 * by", which must render as no tint rather than as an arbitrary group.
 */
export function spawnScopeTaskIds(
  trace: ParsedTrace | null,
  taskId: number | null,
  scope: TaskScope,
): ReadonlySet<number> {
  if (scope !== "spawn-location" || trace === null || taskId === null) {
    return EMPTY_TASK_IDS;
  }
  const location = spawnLocationOf(trace, taskId);
  if (location === null) return EMPTY_TASK_IDS;
  return taskIdsAtSpawnLocation(trace, location);
}

/**
 * Build the view for one (task, scope) pair. `polls` are the selected task's
 * polls (the Task tab's own derivation) and `spawnLocation` its resolved spawn
 * location, or null when the trace does not carry one.
 *
 * A "spawn-location" scope without a location folds nothing: the caller
 * (inspector's activeTaskScope) falls back to the single-task scope before it
 * gets here, and an empty view is the honest answer if it ever does not.
 */
export function buildTaskFlamegraphView(
  trace: ParsedTrace | null,
  taskId: number | null,
  polls: readonly PollSpan[],
  spawnLocation: string | null,
  scope: TaskScope,
): TaskFlamegraphView {
  if (trace === null || taskId === null) {
    return { scope, samples: EMPTY_SAMPLES, taskCount: 0, title: "" };
  }
  const hexId = `0x${taskId.toString(16)}`;
  if (scope === "spawn-location") {
    if (spawnLocation === null) {
      return { scope, samples: EMPTY_SAMPLES, taskCount: 0, title: `Task ${hexId}` };
    }
    return {
      scope,
      samples: spawnLocationCpuSamples(trace, spawnLocation),
      taskCount: tasksAtSpawnLocation(trace, spawnLocation),
      title: `CPU - all tasks from ${spawnLocation}`,
    };
  }
  return {
    scope,
    samples: taskCpuSamples(polls),
    taskCount: 1,
    title: `CPU - task ${hexId}`,
  };
}

/**
 * A signature that changes exactly when the folded tree would. The sample
 * arrays are rebuilt on every derive, so identity is useless here; the inputs
 * that determine the tree are.
 */
export function taskFlamegraphCacheSignature(args: {
  traceId: number;
  taskId: number | null;
  scope: TaskScope;
  spawnLocation: string | null;
  sampleCount: number;
}): string {
  const scopeKey =
    args.scope === "spawn-location" ? (args.spawnLocation ?? "-") : String(args.taskId);
  return `${args.traceId}|${args.scope}|${scopeKey}|${args.sampleCount}`;
}
