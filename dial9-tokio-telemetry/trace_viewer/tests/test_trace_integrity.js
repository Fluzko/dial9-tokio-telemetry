#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { parseTrace, EVENT_TYPES } = require("../trace_parser.js");
const { describe, test, fail, run } = require("./utils.js");

async function main() {
  const tracePath = process.argv[2] || path.join(__dirname, "..", "demo-trace.bin");

  if (!fs.existsSync(tracePath)) {
    console.error(`Trace file not found: ${tracePath}`);
    process.exit(1);
  }

  const stat = fs.statSync(tracePath);
  console.log(`Found trace: ${tracePath} (${stat.size} bytes)`);

  if (stat.size === 0) {
    console.error("Trace file is empty");
    process.exit(1);
  }

  const trace = await parseTrace(fs.readFileSync(tracePath));
  console.log(`Parsed ${trace.events.length} events (version ${trace.version})`);

  function getWorkerIds() {
    const eventsWithWorkerId = trace.events.filter(
      (e) =>
        e.eventType !== EVENT_TYPES.QueueSample &&
        e.eventType !== EVENT_TYPES.WakeEvent
    );
    return [...new Set(eventsWithWorkerId.map((e) => e.workerId))].sort();
  }

  describe("Basic", () => {
    test("has events", () => {
      if (trace.events.length === 0) fail("No events found");
    });

    test("all event types present", () => {
      const typeCounts = {};
      trace.events.forEach((e) => {
        typeCounts[e.eventType] = (typeCounts[e.eventType] || 0) + 1;
      });
      for (const [name, type] of Object.entries(EVENT_TYPES)) {
        const count = typeCounts[type] || 0;
        if (!count) fail(`No ${name} events found`);
      }
    });

    test("multiple workers", () => {
      const workerIds = getWorkerIds();
      if (workerIds.length < 2) fail(`Only ${workerIds.length} worker(s)`);
    });

    test("not truncated", () => {
      if (trace.truncated) fail("Trace was truncated at event cap");
    });
  });

  describe("Task tracking", () => {
    test("tasks spawned", () => {
      if (!trace.taskSpawnLocs.size) fail("No task spawned");
    });

    test("spawn locations resolved", () => {
      const pollStarts = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.PollStart
      );
      const withSpawnLoc = pollStarts.filter((e) => !!e.spawnLoc);
      if (pollStarts.length > 0 && withSpawnLoc.length === 0)
        fail("No PollStart has spawnLoc");
    });

    test("all polled tasks were spawned", () => {
      const pollStarts = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.PollStart
      );
      const unspawnedTasks = [];
      for (const e of pollStarts) {
        if (e.taskId && !trace.taskSpawnLocs.has(e.taskId)) {
          unspawnedTasks.push(e.taskId);
        }
      }
      if (unspawnedTasks.length > 0)
        fail(
          `${unspawnedTasks.length} task(s) polled but never spawned: ${unspawnedTasks.join(", ")}`
        );
    });

    test("task lifecycle consistent (spawn < terminate)", () => {
      const lifecycleErrors = [];
      for (const [taskId, spawnTime] of trace.taskSpawnTimes) {
        const termTime = trace.taskTerminateTimes.get(taskId);
        if (termTime !== undefined && termTime < spawnTime) {
          lifecycleErrors.push(taskId);
        }
      }
      if (lifecycleErrors.length)
        fail(`${lifecycleErrors.length} task(s) terminated before spawn`);
    });
  });

  describe("State machine", () => {
    test("PollStart/PollEnd pairing (no nested polls)", () => {
      const workerIds = getWorkerIds();
      for (const wid of workerIds) {
        const wEvents = trace.events.filter(
          (e) =>
            e.workerId === wid &&
            [EVENT_TYPES.PollStart, EVENT_TYPES.PollEnd].includes(e.eventType)
        );
        const bad = wEvents.find(
          (e, i) => i > 0 && e.eventType === wEvents[i - 1].eventType
        );
        if (bad)
          fail(
            `worker ${wid}: duplicate ${
              bad.eventType === EVENT_TYPES.PollStart ? "PollStart" : "PollEnd"
            } at ts=${bad.timestamp}`
          );
      }
    });

    test("WorkerPark/WorkerUnpark pairing (no double park)", () => {
      const workerIds = getWorkerIds();
      for (const wid of workerIds) {
        const wEvents = trace.events.filter(
          (e) =>
            e.workerId === wid &&
            [EVENT_TYPES.WorkerPark, EVENT_TYPES.WorkerUnpark].includes(
              e.eventType
            )
        );
        const bad = wEvents.find(
          (e, i) => i > 0 && e.eventType === wEvents[i - 1].eventType
        );
        if (bad)
          fail(
            `worker ${wid}: duplicate ${
              bad.eventType === EVENT_TYPES.WorkerPark
                ? "WorkerPark"
                : "WorkerUnpark"
            } at ts=${bad.timestamp}`
          );
      }
    });
  });

  describe("Field sanity", () => {
    test("timestamps increasing per worker", () => {
      const workerIds = getWorkerIds();
      for (const wid of workerIds) {
        const wEvents = trace.events.filter(
          (e) =>
            e.workerId === wid &&
            ![EVENT_TYPES.QueueSample, EVENT_TYPES.WakeEvent].includes(
              e.eventType
            )
        );
        for (let i = 1; i < wEvents.length; i++) {
          if (wEvents[i].timestamp < wEvents[i - 1].timestamp)
            fail(
              `worker ${wid}: ts ${wEvents[i].timestamp} < ${wEvents[i - 1].timestamp} at index ${i}`
            );
        }
      }
    });

    test("queue depths non-negative", () => {
      const negQueue = trace.events.find(
        (e) => e.localQueue < 0 || e.globalQueue < 0
      );
      if (negQueue)
        fail(
          `Negative queue depth: type=${negQueue.eventType} localQueue=${negQueue.localQueue} globalQueue=${negQueue.globalQueue}`
        );
    });

    test("worker IDs bounded", () => {
      const workerIds = getWorkerIds();
      const maxWorkerId = Math.max(...workerIds);
      if (maxWorkerId > 63)
        fail(`Unexpectedly large worker ID: ${maxWorkerId}`);
    });

    test("cpuTime non-negative on Park/Unpark", () => {
      const parks = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WorkerPark
      );
      const unparks = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WorkerUnpark
      );
      const negCpuTime = parks.concat(unparks).find((e) => e.cpuTime < 0);
      if (negCpuTime)
        fail(
          `Negative cpuTime: ${negCpuTime.cpuTime} at ts=${negCpuTime.timestamp}`
        );
    });

    test("schedWait non-negative on Unpark", () => {
      const unparks = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WorkerUnpark
      );
      const negSchedWait = unparks.find((e) => e.schedWait < 0);
      if (negSchedWait)
        fail(
          `Negative schedWait: ${negSchedWait.schedWait} at ts=${negSchedWait.timestamp}`
        );
    });

    test("cpuTime populated", () => {
      const parks = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WorkerPark
      );
      const unparks = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WorkerUnpark
      );
      const nonZeroCpuTime = parks
        .concat(unparks)
        .filter((e) => e.cpuTime > 0);
      if (nonZeroCpuTime.length === 0)
        fail("All cpuTime values are zero — instrumentation may be broken");
    });

    test("WakeEvent wokenTaskId references known tasks", () => {
      const wakeEvents = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WakeEvent
      );
      const unknownWoken = wakeEvents.filter(
        (e) => e.wokenTaskId && !trace.taskSpawnLocs.has(e.wokenTaskId)
      );
      if (unknownWoken.length > 0)
        fail(
          `${unknownWoken.length} WakeEvent(s) reference unknown wokenTaskId (first: ${unknownWoken[0].wokenTaskId})`
        );
    });

    test("WakeEvent targetWorker within valid range", () => {
      const workerIds = getWorkerIds();
      const maxWorkerId = Math.max(...workerIds);
      const wakeEvents = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.WakeEvent
      );
      const outOfRangeWorker = wakeEvents.find(
        (e) => e.targetWorker !== 255 && e.targetWorker > maxWorkerId
      );
      if (outOfRangeWorker)
        fail(
          `WakeEvent targetWorker ${outOfRangeWorker.targetWorker} exceeds max worker ID ${maxWorkerId}`
        );
    });

    test("all PollStart events have a taskId", () => {
      const pollStarts = trace.events.filter(
        (e) => e.eventType === EVENT_TYPES.PollStart
      );
      const zeroTaskPoll = pollStarts.find((e) => !e.taskId);
      if (zeroTaskPoll)
        fail(`PollStart with zero taskId at ts=${zeroTaskPoll.timestamp}`);
    });
  });

  run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
