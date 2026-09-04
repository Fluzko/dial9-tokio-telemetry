// Tests for the Task tab's scope model: which samples each scope folds, which
// tasks the lanes tint, and the fallbacks when the trace never recorded a spawn
// location. Sample gathering runs against the demo trace (real `spawnLoc`
// stamps from attachCpuSamples); the fallbacks run on hand-built stubs, since
// they are about absent data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { parseTraceBuffer } from "../../lib/trace/index.js";
import { sharedDetectorInputs } from "../../lib/trace/derived.js";
import type { CpuSample, ParsedTrace, PollSpan } from "../../types/trace.js";
import {
  TASK_SCOPES,
  buildTaskFlamegraphView,
  parseTaskScope,
  scopeLabel,
  spawnLocationCpuSamples,
  spawnLocationOf,
  spawnScopeTaskIds,
  taskCpuSamples,
  taskFlamegraphCacheSignature,
  taskIdsAtSpawnLocation,
  tasksAtSpawnLocation,
} from "./task-flamegraph-model.js";

let trace: ParsedTrace;

beforeAll(async () => {
  const b = readFileSync(
    fileURLToPath(new URL("../../../public/demo-trace.bin", import.meta.url)),
  );
  const raw = b[0] === 0x1f && b[1] === 0x8b ? new Uint8Array(gunzipSync(b)) : new Uint8Array(b);
  trace = await parseTraceBuffer(raw);
  // Stamps `spawnLoc` on every sample, which the spawn-location scope reads.
  sharedDetectorInputs(trace);
});

/** A spawn location the demo trace has FOLDABLE samples for, plus one of its
 *  tasks. Picking the first sample with any `spawnLoc` is not enough: it may be
 *  off-CPU or stackless, and the scope folds neither. */
function sampledLocation(): { location: string; taskId: number } {
  for (const s of trace.cpuSamples) {
    if (s.spawnLoc == null || s.source === 1 || s.callchain.length === 0) continue;
    const location = trace.spawnLocations.get(s.spawnLoc);
    if (location == null) continue;
    for (const [taskId, locId] of trace.taskSpawnLocs) {
      if (locId != null && trace.spawnLocations.get(locId) === location) {
        return { location, taskId };
      }
    }
  }
  throw new Error("demo trace has no sampled spawn location");
}

function sample(over: Partial<CpuSample> = {}): CpuSample {
  return {
    timestamp: 0,
    workerId: 0,
    tid: 1,
    source: 0,
    callchain: ["0x1"],
    cpu: null,
    ...over,
  } as CpuSample;
}

function poll(over: Partial<PollSpan> = {}): PollSpan {
  return { start: 0, end: 100, taskId: 1, spawnLocId: "L", spawnLoc: null, ...over } as PollSpan;
}

describe("scope vocabulary", () => {
  it("accepts only the two offered scopes", () => {
    expect(parseTaskScope("task")).toBe("task");
    expect(parseTaskScope("spawn-location")).toBe("spawn-location");
    expect(parseTaskScope("everything")).toBeNull();
    expect(parseTaskScope("")).toBeNull();
  });

  it("labels every scope", () => {
    for (const s of TASK_SCOPES) expect(scopeLabel(s).length).toBeGreaterThan(0);
  });
});

describe("taskCpuSamples", () => {
  it("gathers the on-CPU samples attached to the task's polls", () => {
    const kept = sample({ timestamp: 5 });
    const polls = [
      poll({ cpuSamples: [kept] }),
      poll({ start: 200, end: 300 }), // no samples attached
    ];
    expect(taskCpuSamples(polls)).toEqual([kept]);
  });

  it("drops stackless and off-CPU samples, which cannot be folded", () => {
    const polls = [
      poll({
        cpuSamples: [
          sample({ callchain: [] }), // no stack
          sample({ source: 1 }), // off-CPU
        ],
      }),
    ];
    expect(taskCpuSamples(polls)).toEqual([]);
  });
});

describe("spawn-location grouping (demo trace)", () => {
  it("folds every sample stamped with that spawn location", () => {
    const { location } = sampledLocation();
    const samples = spawnLocationCpuSamples(trace, location);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      // Resolve rather than compare directly: a sample carries the spawn
      // location's ID, which only equals the readable string because
      // `spawnLocations` happens to be an identity map today.
      expect(trace.spawnLocations.get(s.spawnLoc!)).toBe(location);
      expect(s.source).not.toBe(1);
      expect(s.callchain.length).toBeGreaterThan(0);
    }
  });

  it("counts the tasks spawned there, and lists the same set the lanes tint", () => {
    const { location } = sampledLocation();
    const ids = taskIdsAtSpawnLocation(trace, location);
    expect(ids.size).toBe(tasksAtSpawnLocation(trace, location));
    expect(ids.size).toBeGreaterThan(0);
  });

  it("memoizes the sibling set per (trace, location)", () => {
    const { location } = sampledLocation();
    expect(taskIdsAtSpawnLocation(trace, location)).toBe(
      taskIdsAtSpawnLocation(trace, location),
    );
  });

  it("resolves a task's spawn location from the task maps", () => {
    const { location, taskId } = sampledLocation();
    expect(spawnLocationOf(trace, taskId)).toBe(location);
  });
});

describe("spawnScopeTaskIds (what the lanes tint)", () => {
  it("is empty for the single-task scope", () => {
    const { taskId } = sampledLocation();
    expect(spawnScopeTaskIds(trace, taskId, "task").size).toBe(0);
  });

  it("is the whole sibling set for the spawn-location scope", () => {
    const { location, taskId } = sampledLocation();
    const ids = spawnScopeTaskIds(trace, taskId, "spawn-location");
    expect(ids).toEqual(taskIdsAtSpawnLocation(trace, location));
    expect(ids.has(taskId)).toBe(true);
  });

  it("is empty with no trace, no selection, or no recorded location", () => {
    expect(spawnScopeTaskIds(null, 1, "spawn-location").size).toBe(0);
    expect(spawnScopeTaskIds(trace, null, "spawn-location").size).toBe(0);
    const unknownTask = Math.max(0, ...trace.taskSpawnLocs.keys()) + 1;
    expect(spawnScopeTaskIds(trace, unknownTask, "spawn-location").size).toBe(0);
  });
});

describe("buildTaskFlamegraphView", () => {
  it("reports the spawn-location scope unavailable without a location", () => {
    const view = buildTaskFlamegraphView(trace, 1, [], null, "spawn-location");
    expect(view.available).toBe(false);
    expect(view.samples).toEqual([]);
    expect(view.taskCount).toBe(0);
  });

  it("scopes to the task alone, titled by its hex id", () => {
    const kept = sample();
    const view = buildTaskFlamegraphView(trace, 0x2a, [poll({ cpuSamples: [kept] })], null, "task");
    expect(view.available).toBe(true);
    expect(view.samples).toEqual([kept]);
    expect(view.taskCount).toBe(1);
    expect(view.title).toContain("0x2a");
  });

  it("scopes to every task at the location, titled by it", () => {
    const { location, taskId } = sampledLocation();
    const view = buildTaskFlamegraphView(trace, taskId, [], location, "spawn-location");
    expect(view.available).toBe(true);
    expect(view.samples.length).toBe(spawnLocationCpuSamples(trace, location).length);
    expect(view.taskCount).toBe(tasksAtSpawnLocation(trace, location));
    expect(view.title).toContain(location);
  });

  it("is unavailable with nothing selected", () => {
    expect(buildTaskFlamegraphView(trace, null, [], null, "task").available).toBe(false);
    expect(buildTaskFlamegraphView(null, 1, [], null, "task").available).toBe(false);
  });
});

describe("taskFlamegraphCacheSignature", () => {
  const base = {
    traceId: 1,
    taskId: 7,
    scope: "task" as const,
    spawnLocation: "src/a.rs:1",
    sampleCount: 3,
  };

  it("is stable for identical inputs", () => {
    expect(taskFlamegraphCacheSignature(base)).toBe(taskFlamegraphCacheSignature(base));
  });

  it("changes with the scope, the trace, and the sample count", () => {
    const sig = taskFlamegraphCacheSignature(base);
    expect(taskFlamegraphCacheSignature({ ...base, scope: "spawn-location" })).not.toBe(sig);
    expect(taskFlamegraphCacheSignature({ ...base, traceId: 2 })).not.toBe(sig);
    expect(taskFlamegraphCacheSignature({ ...base, sampleCount: 4 })).not.toBe(sig);
  });

  it("keys on the task under the task scope and on the location under the other", () => {
    expect(taskFlamegraphCacheSignature({ ...base, taskId: 8 })).not.toBe(
      taskFlamegraphCacheSignature(base),
    );
    const loc = { ...base, scope: "spawn-location" as const };
    // Two tasks from the SAME location fold the same tree, so the signature
    // must not change with the task - re-selecting a sibling would rebuild it.
    expect(taskFlamegraphCacheSignature({ ...loc, taskId: 8 })).toBe(
      taskFlamegraphCacheSignature(loc),
    );
    expect(taskFlamegraphCacheSignature({ ...loc, spawnLocation: "src/b.rs:2" })).not.toBe(
      taskFlamegraphCacheSignature(loc),
    );
  });
});
