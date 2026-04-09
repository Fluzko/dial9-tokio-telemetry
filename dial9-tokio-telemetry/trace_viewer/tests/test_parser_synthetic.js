#!/usr/bin/env node
"use strict";

const { describe, test, fail, run } = require("./utils.js");

function parseTrace(buffer) {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  let off = 0;
  const magic = String.fromCharCode(...buffer.slice(0, 8));
  off += 8;
  const version = view.getUint32(off, true);
  off += 4;
  if (magic !== "TOKIOTRC")
    throw new Error("Not a TOKIOTRC file (got: " + magic + ")");
  const hasCpuTime = version >= 5;

  const events = [];
  while (off < buffer.byteLength) {
    if (off + 1 > buffer.byteLength) break;
    const wireCode = view.getUint8(off);
    off += 1;
    if (wireCode > 6) break;

    if (off + 4 > buffer.byteLength) break;
    const timestampUs = view.getUint32(off, true);
    off += 4;
    const timestamp = timestampUs * 1000;

    let eventType,
      workerId = 0,
      globalQueue = 0,
      localQueue = 0,
      cpuTime = 0;
    switch (wireCode) {
      case 0:
      case 1:
        if (off + 1 > buffer.byteLength) break;
        eventType = wireCode;
        workerId = view.getUint8(off);
        off += 1;
        break;
      case 2:
      case 3: {
        const need = hasCpuTime ? 6 : 2;
        if (off + need > buffer.byteLength) break;
        eventType = wireCode;
        workerId = view.getUint8(off);
        off += 1;
        localQueue = view.getUint8(off);
        off += 1;
        if (hasCpuTime) {
          cpuTime = view.getUint32(off, true) * 1000;
          off += 4;
        }
        break;
      }
      case 4:
        if (off + 1 > buffer.byteLength) break;
        eventType = 4;
        globalQueue = view.getUint8(off);
        off += 1;
        break;
      case 5:
        if (off + 2 > buffer.byteLength) break;
        eventType = 0;
        workerId = view.getUint8(off);
        off += 1;
        localQueue = view.getUint8(off);
        off += 1;
        break;
      case 6:
        if (off + 2 > buffer.byteLength) break;
        eventType = 1;
        workerId = view.getUint8(off);
        off += 1;
        localQueue = view.getUint8(off);
        off += 1;
        break;
    }
    events.push({
      eventType,
      timestamp,
      workerId,
      globalQueue,
      localQueue,
      cpuTime,
    });
  }
  return { magic, version, events };
}

describe("synthetic v5", () => {
  const buf = Buffer.alloc(12 + 6 + 11 + 11 + 6 + 6);
  let o = 0;
  buf.write("TOKIOTRC", 0);
  o += 8;
  buf.writeUInt32LE(5, o);
  o += 4;
  // PollStart lq=0: code=0, ts=100, worker=2
  buf[o++] = 0;
  buf.writeUInt32LE(100, o);
  o += 4;
  buf[o++] = 2;
  // WorkerPark: code=2, ts=200, worker=1, lq=3, cpu_us=500
  buf[o++] = 2;
  buf.writeUInt32LE(200, o);
  o += 4;
  buf[o++] = 1;
  buf[o++] = 3;
  buf.writeUInt32LE(500, o);
  o += 4;
  // WorkerUnpark: code=3, ts=300, worker=1, lq=0, cpu_us=500
  buf[o++] = 3;
  buf.writeUInt32LE(300, o);
  o += 4;
  buf[o++] = 1;
  buf[o++] = 0;
  buf.writeUInt32LE(500, o);
  o += 4;
  // PollEnd lq=0: code=1, ts=400, worker=2
  buf[o++] = 1;
  buf.writeUInt32LE(400, o);
  o += 4;
  buf[o++] = 2;
  // QueueSample: code=4, ts=500, gq=7
  buf[o++] = 4;
  buf.writeUInt32LE(500, o);
  o += 4;
  buf[o++] = 7;

  const trace = parseTrace(buf);
  const e = trace.events;

  test("version is 5", () => {
    if (trace.version !== 5) fail(`version=${trace.version}`);
  });

  test("event count is 5", () => {
    if (e.length !== 5) fail(`count=${e.length}`);
  });

  test("PollStart fields", () => {
    if (e[0].eventType !== 0) fail(`type=${e[0].eventType}`);
    if (e[0].workerId !== 2) fail(`worker=${e[0].workerId}`);
    if (e[0].timestamp !== 100000) fail(`ts=${e[0].timestamp}`);
  });

  test("WorkerPark fields", () => {
    if (e[1].eventType !== 2) fail(`type=${e[1].eventType}`);
    if (e[1].workerId !== 1) fail(`worker=${e[1].workerId}`);
    if (e[1].localQueue !== 3) fail(`lq=${e[1].localQueue}`);
    if (e[1].cpuTime !== 500000) fail(`cpu=${e[1].cpuTime}`);
  });

  test("WorkerUnpark fields", () => {
    if (e[2].eventType !== 3) fail(`type=${e[2].eventType}`);
    if (e[2].workerId !== 1) fail(`worker=${e[2].workerId}`);
    if (e[2].cpuTime !== 500000) fail(`cpu=${e[2].cpuTime}`);
  });

  test("PollEnd fields", () => {
    if (e[3].eventType !== 1) fail(`type=${e[3].eventType}`);
    if (e[3].workerId !== 2) fail(`worker=${e[3].workerId}`);
  });

  test("QueueSample fields", () => {
    if (e[4].eventType !== 4) fail(`type=${e[4].eventType}`);
    if (e[4].globalQueue !== 7) fail(`gq=${e[4].globalQueue}`);
  });
});

describe("synthetic v4", () => {
  const buf = Buffer.alloc(12 + 7 + 7 + 6);
  let o = 0;
  buf.write("TOKIOTRC", 0);
  o += 8;
  buf.writeUInt32LE(4, o);
  o += 4;
  // WorkerPark: code=2, ts=100, worker=0, lq=5
  buf[o++] = 2;
  buf.writeUInt32LE(100, o);
  o += 4;
  buf[o++] = 0;
  buf[o++] = 5;
  // WorkerUnpark: code=3, ts=200, worker=0, lq=0
  buf[o++] = 3;
  buf.writeUInt32LE(200, o);
  o += 4;
  buf[o++] = 0;
  buf[o++] = 0;
  // PollStart lq=0: code=0, ts=300, worker=0
  buf[o++] = 0;
  buf.writeUInt32LE(300, o);
  o += 4;
  buf[o++] = 0;

  const trace = parseTrace(buf);
  const e = trace.events;

  test("version is 4", () => {
    if (trace.version !== 4) fail(`version=${trace.version}`);
  });

  test("event count is 3", () => {
    if (e.length !== 3) fail(`count=${e.length}`);
  });

  test("WorkerPark fields (no cpuTime in v4)", () => {
    if (e[0].eventType !== 2) fail(`type=${e[0].eventType}`);
    if (e[0].workerId !== 0) fail(`worker=${e[0].workerId}`);
    if (e[0].localQueue !== 5) fail(`lq=${e[0].localQueue}`);
    if (e[0].cpuTime !== 0) fail(`cpu=${e[0].cpuTime}`);
  });

  test("WorkerUnpark fields", () => {
    if (e[1].eventType !== 3) fail(`type=${e[1].eventType}`);
    if (e[1].workerId !== 0) fail(`worker=${e[1].workerId}`);
  });

  test("PollStart fields", () => {
    if (e[2].eventType !== 0) fail(`type=${e[2].eventType}`);
    if (e[2].workerId !== 0) fail(`worker=${e[2].workerId}`);
    if (e[2].timestamp !== 300000) fail(`ts=${e[2].timestamp}`);
  });
});

describe("span building with out-of-order events", () => {
  const ET = {
    PollStart: 0,
    PollEnd: 1,
    WorkerPark: 2,
    WorkerUnpark: 3,
    QueueSample: 4,
  };
  const evts = [
    {
      eventType: ET.WorkerPark,
      timestamp: 100,
      workerId: 0,
      cpuTime: 50,
      localQueue: 0,
      globalQueue: 0,
    },
    {
      eventType: ET.WorkerUnpark,
      timestamp: 80,
      workerId: 1,
      cpuTime: 20,
      localQueue: 0,
      globalQueue: 0,
    },
    {
      eventType: ET.WorkerPark,
      timestamp: 200,
      workerId: 1,
      cpuTime: 100,
      localQueue: 0,
      globalQueue: 0,
    },
    {
      eventType: ET.WorkerUnpark,
      timestamp: 150,
      workerId: 0,
      cpuTime: 50,
      localQueue: 0,
      globalQueue: 0,
    },
    {
      eventType: ET.WorkerPark,
      timestamp: 300,
      workerId: 0,
      cpuTime: 180,
      localQueue: 0,
      globalQueue: 0,
    },
  ];

  const perWorker = {};
  for (const e of evts) {
    if (e.eventType === ET.QueueSample) continue;
    (perWorker[e.workerId] ??= []).push(e);
  }
  for (const wEvents of Object.values(perWorker)) {
    wEvents.sort((a, b) => a.timestamp - b.timestamp);
  }

  const actives = {};
  const openUnpark = {};
  for (const [w, wEvents] of Object.entries(perWorker)) {
    actives[w] = [];
    for (const e of wEvents) {
      if (e.eventType === ET.WorkerPark) {
        if (openUnpark[w] != null) {
          const wallDelta = e.timestamp - openUnpark[w].timestamp;
          const cpuDelta = e.cpuTime - openUnpark[w].cpuTime;
          const ratio =
            wallDelta > 0 ? Math.min(cpuDelta / wallDelta, 1.0) : 1.0;
          actives[w].push({
            start: openUnpark[w].timestamp,
            end: e.timestamp,
            ratio,
          });
          openUnpark[w] = null;
        }
      } else if (e.eventType === ET.WorkerUnpark) {
        openUnpark[w] = { timestamp: e.timestamp, cpuTime: e.cpuTime };
      }
    }
  }

  // Worker 0: unpark@150(cpu=50) -> park@300(cpu=180) -> ratio = 130/150 = 0.867
  test("worker 0 active span", () => {
    if (actives[0].length !== 1) fail(`w0 actives=${actives[0].length}`);
    if (actives[0][0].start !== 150) fail(`w0 start=${actives[0][0].start}`);
    if (actives[0][0].end !== 300) fail(`w0 end=${actives[0][0].end}`);
    if (Math.abs(actives[0][0].ratio - 130 / 150) >= 0.01)
      fail(`w0 ratio=${actives[0][0].ratio}`);
  });

  // Worker 1: unpark@80(cpu=20) -> park@200(cpu=100) -> ratio = 80/120 = 0.667
  test("worker 1 active span", () => {
    if (actives[1].length !== 1) fail(`w1 actives=${actives[1].length}`);
    if (Math.abs(actives[1][0].ratio - 80 / 120) >= 0.01)
      fail(`w1 ratio=${actives[1][0].ratio}`);
  });
});

run();
