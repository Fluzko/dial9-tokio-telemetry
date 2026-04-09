#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { parseTrace } = require("../trace_parser.js");
const { describe, test, fail, run } = require("./utils.js");

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node test_parser.js <trace.bin> <expected.jsonl>");
    process.exit(1);
  }

  const [tracePath, jsonlPath] = args;

  console.log(`Parsing ${tracePath}...`);
  const trace = await parseTrace(fs.readFileSync(tracePath));

  console.log(`Parsed ${trace.events.length} events (version ${trace.version})`);
  console.log(`  - ${trace.spawnLocations.size} spawn locations`);
  console.log(`  - ${trace.taskSpawnLocs.size} task spawns`);
  console.log(`  - ${trace.cpuSamples.length} CPU samples`);
  console.log(`  - ${trace.callframeSymbols.size} callframe symbols`);

  console.log(`\nReading expected output from ${jsonlPath}...`);
  const jsonl = fs.readFileSync(jsonlPath, "utf8");
  const expectedEvents = jsonl
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  console.log(`Expected ${expectedEvents.length} events`);

  const rustNameToType = {
    PollStart: 0,
    PollEnd: 1,
    WorkerPark: 2,
    WorkerUnpark: 3,
    QueueSample: 4,
    WakeEvent: 9,
  };

  const rustRuntimeEvents = expectedEvents.filter(
    (e) => e.event in rustNameToType
  );
  const jsEventCounts = {};
  const rustEventCounts = {};

  trace.events.forEach((e) => {
    jsEventCounts[e.eventType] = (jsEventCounts[e.eventType] || 0) + 1;
  });
  rustRuntimeEvents.forEach((e) => {
    const t = rustNameToType[e.event];
    rustEventCounts[t] = (rustEventCounts[t] || 0) + 1;
  });

  describe("JS vs Rust parser", () => {
    test("event counts match", () => {
      const allTypes = new Set([
        ...Object.keys(jsEventCounts),
        ...Object.keys(rustEventCounts),
      ]);
      for (const t of allTypes) {
        if ((jsEventCounts[t] || 0) !== (rustEventCounts[t] || 0))
          fail(
            `Type ${t}: JS=${jsEventCounts[t] || 0} Rust=${rustEventCounts[t] || 0}`
          );
      }
    });

    test("callframe symbols match", () => {
      const rustCallframes = new Map();
      expectedEvents
        .filter((e) => e.event === "CallframeDef")
        .forEach((e) => {
          const addr = `0x${e.address.toString(16)}`;
          rustCallframes.set(
            addr,
            e.location ? `${e.symbol} @ ${e.location}` : e.symbol
          );
        });

      for (const [addr, jsEntry] of trace.callframeSymbols) {
        const rustSymbol = rustCallframes.get(addr);
        const jsSymbol = jsEntry.location
          ? `${jsEntry.symbol} @ ${jsEntry.location}`
          : jsEntry.symbol;
        if (!rustSymbol) fail(`MISSING in Rust: ${addr}`);
        else if (jsSymbol !== rustSymbol)
          fail(`MISMATCH ${addr}: JS="${jsSymbol}" Rust="${rustSymbol}"`);
      }
    });

    test("CPU sample count matches", () => {
      const rustCpuSamples = expectedEvents.filter(
        (e) => e.event === "CpuSample"
      ).length;
      if (trace.cpuSamples.length !== rustCpuSamples)
        fail(`JS=${trace.cpuSamples.length} Rust=${rustCpuSamples}`);
    });

    test("spawn locations resolved on PollStart events", () => {
      const pollStarts = trace.events.filter((e) => e.eventType === 0);
      const withSpawnLoc = pollStarts.filter((e) => e.spawnLoc !== null);
      if (pollStarts.length > 0 && withSpawnLoc.length === 0)
        fail("No PollStart events have spawn locations resolved");
    });

    test("spot-check first 50 events field-by-field", () => {
      let jsIdx = 0;
      for (const re of rustRuntimeEvents.slice(0, 50)) {
        const je = trace.events[jsIdx++];
        if (!je) fail(`Missing JS event at index ${jsIdx - 1}`);
        const expectedType = rustNameToType[re.event];
        if (je.eventType !== expectedType)
          fail(
            `Event ${jsIdx - 1}: type JS=${je.eventType} Rust=${expectedType}`
          );
        if (je.timestamp !== re.timestamp_ns)
          fail(
            `Event ${jsIdx - 1} (${re.event}): timestamp JS=${je.timestamp} Rust=${re.timestamp_ns}`
          );
      }
    });
  });

  run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
