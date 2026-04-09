#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { EVENT_TYPES, parseTrace } = require("../trace_parser.js");
const {
  buildWorkerSpans,
  attachCpuSamples,
  extractLocalQueueSamples,
  buildActiveTaskTimeline,
  indexWakeEvents,
  computeSchedulingDelays,
  filterPointsOfInterest,
  buildFlamegraphTree,
  flattenFlamegraph,
  buildFgData,
} = require("../trace_analysis.js");
const { describe, test, fail, run } = require("./utils.js");

async function main() {
  const tracePath =
    process.argv[2] || path.join(__dirname, "..", "demo-trace.bin");

  if (!fs.existsSync(tracePath)) {
    console.error(`Trace file not found: ${tracePath}`);
    process.exit(1);
  }

  const trace = await parseTrace(fs.readFileSync(tracePath));
  const evts = trace.events;

  const wSet = new Set();
  evts.forEach((e) => {
    if (
      e.eventType !== EVENT_TYPES.QueueSample &&
      e.eventType !== EVENT_TYPES.WakeEvent
    )
      wSet.add(e.workerId);
  });
  const workerIds = [...wSet].sort((a, b) => a - b);

  let maxTs = evts[evts.length - 1].timestamp;
  for (const e of evts) {
    if (e.timestamp > maxTs) maxTs = e.timestamp;
  }

  const { workerSpans, perWorker, queueSamples } = buildWorkerSpans(
    evts,
    workerIds,
    maxTs
  );
  const cpuResult = attachCpuSamples(trace.cpuSamples, workerSpans);
  const { workerQueueSamples, maxLocalQueue } = extractLocalQueueSamples(
    perWorker,
    workerIds
  );
  const { activeTaskSamples } = buildActiveTaskTimeline(
    trace.taskSpawnTimes,
    trace.taskTerminateTimes
  );
  const { wakesByTask, wakesByWorker } = indexWakeEvents(evts);
  const schedDelays = computeSchedulingDelays(
    workerSpans,
    workerIds,
    wakesByTask
  );

  describe("buildWorkerSpans", () => {
    test("polls have valid range", () => {
      for (const w of workerIds) {
        for (const p of workerSpans[w].polls) {
          if (p.start > p.end)
            fail(`Worker ${w}: poll start > end (${p.start} > ${p.end})`);
        }
      }
    });

    test("no overlapping polls on same worker", () => {
      for (const w of workerIds) {
        const polls = workerSpans[w].polls;
        for (let i = 1; i < polls.length; i++) {
          if (polls[i].start < polls[i - 1].end)
            fail(`Worker ${w}: overlapping polls at index ${i}`);
        }
      }
    });

    test("active period ratios in [0, 1]", () => {
      for (const w of workerIds) {
        for (const a of workerSpans[w].actives) {
          if (a.ratio < 0 || a.ratio > 1)
            fail(`Worker ${w}: active ratio ${a.ratio} out of [0, 1]`);
        }
      }
    });

    test("all parks have start <= end", () => {
      for (const w of workerIds) {
        for (const p of workerSpans[w].parks) {
          if (p.start > p.end) fail(`Worker ${w}: park start > end`);
        }
      }
    });

    test("queue samples exist", () => {
      if (queueSamples.length === 0) fail("No queue samples");
    });
  });

  describe("attachCpuSamples", () => {
    test("attached samples within poll bounds", () => {
      for (const w of workerIds) {
        for (const p of workerSpans[w].polls) {
          if (p.cpuSamples) {
            for (const s of p.cpuSamples) {
              if (s.timestamp < p.start || s.timestamp > p.end)
                fail(
                  `Worker ${w}: cpu sample at ${s.timestamp} outside poll [${p.start}, ${p.end}]`
                );
            }
          }
          if (p.schedSamples) {
            for (const s of p.schedSamples) {
              if (s.timestamp < p.start || s.timestamp > p.end)
                fail(
                  `Worker ${w}: sched sample at ${s.timestamp} outside poll [${p.start}, ${p.end}]`
                );
            }
          }
        }
      }
    });

    test("cpu result counts non-negative", () => {
      if (
        cpuResult.pollsWithCpuSamples < 0 ||
        cpuResult.pollsWithSchedSamples < 0
      )
        fail("Negative sample counts");
    });
  });

  describe("extractLocalQueueSamples", () => {
    test("local queue depths non-negative", () => {
      for (const w of workerIds) {
        for (const s of workerQueueSamples[w]) {
          if (s.local < 0) fail(`Worker ${w}: negative local queue ${s.local}`);
        }
      }
    });

    test("maxLocalQueue >= 1", () => {
      if (maxLocalQueue < 1) fail(`maxLocalQueue ${maxLocalQueue} < 1`);
    });
  });

  describe("buildActiveTaskTimeline", () => {
    test("timeline sorted by timestamp", () => {
      for (let i = 1; i < activeTaskSamples.length; i++) {
        if (activeTaskSamples[i].t < activeTaskSamples[i - 1].t)
          fail(`Timeline not sorted at index ${i}`);
      }
    });

    test("task counts non-negative", () => {
      for (const s of activeTaskSamples) {
        if (s.count < 0) fail(`Negative task count ${s.count}`);
      }
    });
  });

  describe("indexWakeEvents", () => {
    test("wakesByTask sorted by timestamp", () => {
      for (const arr of Object.values(wakesByTask)) {
        for (let i = 1; i < arr.length; i++) {
          if (arr[i].timestamp < arr[i - 1].timestamp)
            fail("wakesByTask not sorted");
        }
      }
    });

    test("wakesByWorker sorted by timestamp", () => {
      for (const arr of Object.values(wakesByWorker)) {
        for (let i = 1; i < arr.length; i++) {
          if (arr[i].timestamp < arr[i - 1].timestamp)
            fail("wakesByWorker not sorted");
        }
      }
    });

    test("wake counts consistent", () => {
      let taskTotal = 0;
      for (const arr of Object.values(wakesByTask)) taskTotal += arr.length;
      let workerTotal = 0;
      for (const arr of Object.values(wakesByWorker)) workerTotal += arr.length;
      if (taskTotal !== workerTotal)
        fail(
          `wakesByTask total ${taskTotal} != wakesByWorker total ${workerTotal}`
        );
    });
  });

  describe("computeSchedulingDelays", () => {
    test("all delays positive", () => {
      for (const sd of schedDelays) {
        if (sd.delay <= 0) fail(`Non-positive delay: ${sd.delay}`);
      }
    });

    test("all delays < 1s", () => {
      for (const sd of schedDelays) {
        if (sd.delay >= 1e9) fail(`Delay >= 1s: ${sd.delay}`);
      }
    });

    test("wakeTime < pollTime for all delays", () => {
      for (const sd of schedDelays) {
        if (sd.wakeTime >= sd.pollTime)
          fail(`wakeTime ${sd.wakeTime} >= pollTime ${sd.pollTime}`);
      }
    });

    test("schedDelays sorted by wakeTime", () => {
      for (let i = 1; i < schedDelays.length; i++) {
        if (schedDelays[i].wakeTime < schedDelays[i - 1].wakeTime)
          fail("schedDelays not sorted by wakeTime");
      }
    });
  });

  describe("filterPointsOfInterest", () => {
    test("long-poll filter", () => {
      const pois = filterPointsOfInterest(
        "long-poll",
        workerSpans,
        workerIds,
        schedDelays,
        trace.hasSchedWait,
        {}
      );
      for (const p of pois) {
        if (p.type !== "long-poll") fail(`Wrong type: ${p.type}`);
        if (p.value <= 1) fail(`long-poll value ${p.value} <= 1ms`);
      }
    });

    test("cpu-sampled filter", () => {
      const pois = filterPointsOfInterest(
        "cpu-sampled",
        workerSpans,
        workerIds,
        schedDelays,
        trace.hasSchedWait,
        {}
      );
      for (const p of pois) {
        if (p.type !== "cpu-sampled") fail(`Wrong type: ${p.type}`);
        if (p.value <= 0) fail(`cpu-sampled value ${p.value} <= 0`);
      }
    });

    test("wake-delay filter", () => {
      const pois = filterPointsOfInterest(
        "wake-delay",
        workerSpans,
        workerIds,
        schedDelays,
        trace.hasSchedWait,
        {}
      );
      for (const p of pois) {
        if (p.type !== "wake-delay") fail(`Wrong type: ${p.type}`);
        if (p.value <= 100) fail(`wake-delay value ${p.value} <= 100µs`);
      }
    });

    test("sortByWorst produces descending order", () => {
      const pois = filterPointsOfInterest(
        "long-poll",
        workerSpans,
        workerIds,
        schedDelays,
        trace.hasSchedWait,
        { sortByWorst: true }
      );
      for (let i = 1; i < pois.length; i++) {
        if (pois[i].value > pois[i - 1].value)
          fail("sortByWorst not descending");
      }
    });
  });

  describe("flamegraph", () => {
    test("flamegraph tree root count matches sample count", () => {
      const cpuSamples = trace.cpuSamples.filter((s) => s.source !== 1);
      if (cpuSamples.length === 0) return;

      const root = buildFlamegraphTree(cpuSamples, trace.callframeSymbols);
      if (root.count !== cpuSamples.length)
        fail(`Root count ${root.count} != sample count ${cpuSamples.length}`);
    });

    test("flattenFlamegraph nodes valid", () => {
      const cpuSamples = trace.cpuSamples.filter((s) => s.source !== 1);
      if (cpuSamples.length === 0) return;

      const root = buildFlamegraphTree(cpuSamples, trace.callframeSymbols);
      const { nodes, maxDepth } = flattenFlamegraph(root, cpuSamples.length);
      for (const n of nodes) {
        if (n.x < 0 || n.x >= 1) fail(`Node x=${n.x} out of [0, 1)`);
        if (n.w <= 0) fail(`Node w=${n.w} <= 0`);
      }
      if (maxDepth < 0) fail(`maxDepth ${maxDepth} < 0`);
    });

    test("buildFgData produces valid output", () => {
      const cpuSamples = trace.cpuSamples.filter((s) => s.source !== 1);
      if (cpuSamples.length === 0) return;

      const data = buildFgData(cpuSamples, trace.callframeSymbols);
      if (!data) fail("buildFgData returned null for non-empty samples");
      if (data.totalSamples !== cpuSamples.length)
        fail(`totalSamples ${data.totalSamples} != ${cpuSamples.length}`);
    });

    test("buildFgData returns null for empty samples", () => {
      const data = buildFgData([], trace.callframeSymbols);
      if (data !== null)
        fail("buildFgData should return null for empty samples");
    });
  });

  run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
