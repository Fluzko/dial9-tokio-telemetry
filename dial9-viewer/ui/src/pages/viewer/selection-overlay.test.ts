// Selection overlay: the pure "which box to show" precedence and the box
// placement math (blue region / teal zoom). The DOM mount is thin; the logic
// under test is these two pure functions.

import { describe, it, expect } from "vitest";
import {
  activeSelectionRegion,
  measureLabelPlacement,
  measureText,
  measureWidth,
  selectionBox,
  selectionSpan,
  highlightLaneRow,
} from "./selection-overlay.js";
import { timePanelLayout, LABEL_W } from "../../lib/canvas/layout.js";
import type { SelectionSlice, TransientSlice } from "../../types/state.js";

function transient(over: Partial<TransientSlice> = {}): TransientSlice {
  return {
    mouseNs: null,
    hoverEventTs: null,
    drag: null,
    keyboardSelection: null,
    atCursor: null,
    ...over,
  };
}

function selection(over: Partial<SelectionSlice> = {}): SelectionSlice {
  return {
    selectedTaskId: null,
    spanFocus: null,
    focusedSpanId: null,
    pollDetail: null,
    pinnedEvent: null,
    taskDump: null,
    sidebarRange: null,
    highlight: null,
    hoveredWakerTaskId: null,
    scopedSpawnLoc: null,
    spawnedTasksRange: null,
    ...over,
  };
}

/** The trace extent the retained-box rule compares against. */
const EXTENT = { minTs: 0, maxTs: 10_000 };

/** A jump marker; only its range matters to the precedence rules. */
const marker = (startNs: number, endNs: number): SelectionSlice["highlight"] => ({
  startNs, endNs, worker: 0, source: { kind: "off-cpu-active", severityNs: 1_000 },
});

describe("activeSelectionRegion - precedence", () => {
  it("a live keyboard selection wins over everything", () => {
    const region = activeSelectionRegion(
      transient({ keyboardSelection: { kind: "zoom-select", startNs: 800, cursorNs: 200 } }),
      selection({ sidebarRange: { startNs: 0, endNs: 9_999 } }),
      EXTENT,
    );
    expect(region).toEqual({ startNs: 200, endNs: 800, mode: "zoom" });
  });

  it("a moved region/zoom drag draws the live box", () => {
    const region = activeSelectionRegion(
      transient({ drag: { kind: "region-select", startX: 0, startNs: 400, curNs: 100, moved: true } }),
      selection(),
      EXTENT,
    );
    expect(region).toEqual({ startNs: 100, endNs: 400, mode: "region" });
  });

  it("a PAN drag draws no box (moves the viewport, not a selection)", () => {
    const region = activeSelectionRegion(
      transient({ drag: { kind: "pan", startX: 0, startNs: 400, curNs: 100, moved: true } }),
      selection(),
      EXTENT,
    );
    expect(region).toBeNull();
  });

  it("an UNMOVED select drag draws no live box (falls through)", () => {
    const region = activeSelectionRegion(
      transient({ drag: { kind: "region-select", startX: 0, startNs: 400, curNs: 400, moved: false } }),
      selection(),
      EXTENT,
    );
    expect(region).toBeNull();
  });

  it("a retained sidebar range persists as a blue box (no live gesture)", () => {
    const region = activeSelectionRegion(
      transient(),
      selection({ sidebarRange: { startNs: 1_000, endNs: 2_000 } }),
      EXTENT,
    );
    expect(region).toEqual({ startNs: 1_000, endNs: 2_000, mode: "region" });
  });

  it("a retained range covering the whole trace draws NO box (issue #796)", () => {
    // The toolbar Flamegraph / Blocking Calls / Heap buttons open a whole-trace
    // analysis by retaining [minTs, maxTs]; boxing everything just tints the
    // page blue without distinguishing any scope.
    const region = activeSelectionRegion(
      transient(),
      selection({ sidebarRange: { startNs: EXTENT.minTs, endNs: EXTENT.maxTs } }),
      EXTENT,
    );
    expect(region).toBeNull();
  });

  it("a retained range one ns short of the extent still draws its box", () => {
    const region = activeSelectionRegion(
      transient(),
      selection({ sidebarRange: { startNs: EXTENT.minTs + 1, endNs: EXTENT.maxTs } }),
      EXTENT,
    );
    expect(region).toEqual({
      startNs: EXTENT.minTs + 1,
      endNs: EXTENT.maxTs,
      mode: "region",
    });
  });

  it("an issues-rail jump range draws the amber POI box", () => {
    const region = activeSelectionRegion(
      transient(),
      selection({ highlight: marker(3_000, 4_000) }),
      EXTENT,
    );
    expect(region).toEqual({ startNs: 3_000, endNs: 4_000, mode: "poi" });
  });

  it("a POI jump range yields to a retained analysis and to a live gesture", () => {
    const highlight = marker(3_000, 4_000);
    expect(
      activeSelectionRegion(
        transient(),
        selection({ highlight, sidebarRange: { startNs: 1_000, endNs: 2_000 } }),
        EXTENT,
      ),
    ).toEqual({ startNs: 1_000, endNs: 2_000, mode: "region" });
    expect(
      activeSelectionRegion(
        transient({ drag: { kind: "region-select", startX: 0, startNs: 400, curNs: 100, moved: true } }),
        selection({ highlight }),
        EXTENT,
      ),
    ).toEqual({ startNs: 100, endNs: 400, mode: "region" });
  });

  it("a POI jump range covering the whole trace still draws its box", () => {
    // Unlike a retained analysis, this box IS the subject: an off-cpu-active
    // period that happens to span the resident window is still the thing the
    // rail row points at.
    const region = activeSelectionRegion(
      transient(),
      selection({ highlight: marker(EXTENT.minTs, EXTENT.maxTs) }),
      EXTENT,
    );
    expect(region).toEqual({
      startNs: EXTENT.minTs,
      endNs: EXTENT.maxTs,
      mode: "poi",
    });
  });

  it("nothing selected => null (box hidden)", () => {
    expect(activeSelectionRegion(transient(), selection(), EXTENT)).toBeNull();
  });
});

describe("selectionSpan - vertical extent", () => {
  // The worker-lanes viewport sits below the ruler and above the analysis
  // tracks; the column scrolls past both.
  const spanning = {
    lanes: { top: 65, bottom: 516 },
    columnHeight: 846,
    laneRow: null,
    lanesScrollTop: 0,
  };
  // W1 of four 60px rows under a 24px runtime header.
  const onRow = { ...spanning, laneRow: { y: 84, height: 60 } };

  it("spans the whole viewport for a drag selection", () => {
    expect(selectionSpan(spanning)).toEqual({ top: 65, height: 451 });
  });

  it("bounds a worker-scoped highlight to that row alone", () => {
    // The problem happened on ONE worker; boxing all of them says the runtime
    // stalled.
    expect(selectionSpan(onRow)).toEqual({ top: 149, height: 60 });
  });

  it("moves the row box as the lanes scroll under it", () => {
    expect(selectionSpan({ ...onRow, lanesScrollTop: 40 }).top).toBe(109);
  });

  it("clips a row scrolled half out of the viewport", () => {
    // Row top would land 20px above the viewport; only the lower 40px show.
    expect(selectionSpan({ ...onRow, lanesScrollTop: 104 }))
      .toEqual({ top: 65, height: 40 });
  });

  it("collapses a row scrolled fully out rather than drawing over the tracks", () => {
    expect(selectionSpan({ ...onRow, lanesScrollTop: 400 }).height).toBe(0);
    expect(selectionSpan({ ...onRow, lanesScrollTop: -600 }).height).toBe(0);
  });

  it("follows the viewport's height, which the user drags by hand", () => {
    expect(selectionSpan({ ...spanning, lanes: { top: 65, bottom: 300 } }).height)
      .toBe(235);
  });

  it("falls back to the column before the lanes mount", () => {
    expect(selectionSpan({ ...spanning, lanes: null }))
      .toEqual({ top: 0, height: 846 });
  });

  it("clamps an inverted viewport to zero rather than a negative height", () => {
    expect(selectionSpan({ ...spanning, lanes: { top: 65, bottom: 40 } }).height)
      .toBe(0);
  });
});

describe("highlightLaneRow - which row a highlight marks", () => {
  const rows = [
    { kind: "header", name: "main", inferred: true, workerCount: 2, collapsed: false, y: 0, height: 24 },
    { kind: "worker", workerId: 0, index: 0, y: 24, height: 60 },
    { kind: "worker", workerId: 1, index: 1, y: 84, height: 60 },
    { kind: "runtime-metrics", name: "main", inferred: true, collapsed: false, y: 144, height: 60 },
    { kind: "header", name: "io", inferred: false, workerCount: 2, collapsed: false, y: 204, height: 24 },
    { kind: "worker", workerId: 2, index: 2, y: 228, height: 60 },
  ] as unknown as Parameters<typeof highlightLaneRow>[0];

  it("finds the named worker's row", () => {
    expect(highlightLaneRow(rows, 1)).toEqual({ y: 84, height: 60 });
    expect(highlightLaneRow(rows, 2)).toEqual({ y: 228, height: 60 });
  });

  it("spans the lanes when the highlight names no worker", () => {
    expect(highlightLaneRow(rows, null)).toBeNull();
  });

  it("never lands on a header or a metrics lane", () => {
    // Worker ids and row indices share a number space; matching the wrong kind
    // would box a runtime summary as though it were a worker.
    expect(highlightLaneRow(rows, 0)).toEqual({ y: 24, height: 60 });
  });

  it("falls back to the folded runtime's header, where the row went", () => {
    const folded = [
      { kind: "header", name: "main", inferred: true, workerCount: 2, collapsed: true, y: 0, height: 24 },
    ] as unknown as Parameters<typeof highlightLaneRow>[0];
    expect(highlightLaneRow(folded, 0)).toEqual({ y: 0, height: 24 });
  });

  it("gives up when the worker is nowhere to be found", () => {
    expect(highlightLaneRow(rows, 99)).toBeNull();
  });
});

describe("selectionBox - placement (shared ns<->x mapping)", () => {
  const layout = timePanelLayout({ pw: 1_000, scrollbarW: 0, viewStart: 0, viewEnd: 1_000 });

  it("maps [start,end] through the same layout the lanes use", () => {
    // drawW = 1000 - LABEL_W; x(ns) = LABEL_W + ns/1000 * drawW.
    const box = selectionBox({ startNs: 250, endNs: 750, mode: "region" }, layout);
    const drawW = 1_000 - LABEL_W;
    expect(box.left).toBeCloseTo(LABEL_W + 0.25 * drawW, 6);
    expect(box.width).toBeCloseTo(0.5 * drawW, 6);
  });

  it("clamps edges outside the view into the draw area", () => {
    // A keyboard cursor panned past the right edge still renders in-bounds.
    const box = selectionBox({ startNs: 500, endNs: 5_000, mode: "zoom" }, layout);
    expect(box.left + box.width).toBeCloseTo(1_000, 6); // right edge = LABEL_W + drawW = pw
  });

  it("guarantees at least 1px width for a degenerate region", () => {
    expect(selectionBox({ startNs: 500, endNs: 500, mode: "region" }, layout).width).toBe(1);
  });
});

describe("measuring bar", () => {
  it("states the selection duration, and nothing for a zero-length one", () => {
    expect(measureText({ startNs: 0, endNs: 5e5, mode: "region" })).toBe("500µs");
    expect(measureText({ startNs: 7, endNs: 7, mode: "region" })).toBeNull();
  });

  const drawArea = { left: 100, right: 900 };

  it("centres the label inside a box that can hold it", () => {
    const labelW = measureWidth("500µs");
    const { placement, offsetX } = measureLabelPlacement(
      { left: 200, width: 300 },
      drawArea,
      labelW,
    );
    expect(placement).toBe("inside");
    expect(offsetX).toBe((300 - labelW) / 2);
  });

  it("parks the label to the right of a pinched box", () => {
    const labelW = measureWidth("500µs");
    const { placement, offsetX } = measureLabelPlacement(
      { left: 200, width: 4 },
      drawArea,
      labelW,
    );
    expect(placement).toBe("right");
    expect(offsetX).toBe(8);
  });

  it("parks the label to the left when the right edge has no room", () => {
    const labelW = measureWidth("500µs");
    const { placement, offsetX } = measureLabelPlacement(
      { left: 890, width: 4 },
      drawArea,
      labelW,
    );
    expect(placement).toBe("left");
    expect(offsetX).toBe(-labelW - 4);
  });

  it("falls back to inside when neither side fits (a sliver of draw area)", () => {
    const labelW = measureWidth("500µs");
    const { placement } = measureLabelPlacement(
      { left: 100, width: 4 },
      { left: 100, right: 110 },
      labelW,
    );
    expect(placement).toBe("inside");
  });
});
