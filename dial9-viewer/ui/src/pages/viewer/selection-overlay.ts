// The selection overlay: the blue (region) / teal (zoom) box drawn over the
// lanes during a Shift/Alt drag or a keyboard selection, plus the persistent box
// for a retained region.
//
// A store render surface, not a handler: the pointer / keyboard machines write
// `transient.drag` / `transient.keyboardSelection` (and, on a region confirm,
// `selection.sidebarRange`); this subscriber reads those slices on the store's
// RAF tick and positions one absolutely-placed div. So it renders only from a
// subscription (never the input handler) and reads geometry once, before the
// write - the same discipline as the crosshair overlay, on the same track column.
//
// A Shift region stays boxed until the sidebar clears `selection.sidebarRange`.
// The transient drag/keyboard box takes precedence while a selection is in flight.

import { assertInScheduledRender } from "../../store/store.js";
import { poiHighlightCaption } from "./poi.js";
import { timePanelLayout } from "../../lib/canvas/layout.js";
import type { TimePanelLayout } from "../../lib/canvas/layout.js";
import { lanesScrollbarWidth } from "../../lib/canvas/track-layout.js";
import type { ViewerStore } from "../../store/store.js";
import type {
  PoiHighlight,
  SelectionSlice,
  TransientSlice,
} from "../../types/state.js";

const OVERLAY_CLASS = "d9-selection-overlay";
const CAPTION_CLASS = "d9-selection-caption";
const ZOOM_MODIFIER = "zoom";
const POI_MODIFIER = "poi";
/** Below this box width the caption is dropped rather than clipped to a few
 *  unreadable characters. */
const CAPTION_MIN_WIDTH = 90;
/** The track stack the box is sized to, and the ruler it starts below. */
const TRACKS_CLASS = "d9-tracks";
const RULER_TRACK_ID = "timeline";

/** Which encoding the box uses: region (blue), zoom (teal), or POI (amber). */
export type SelectionMode = "region" | "zoom" | "poi";

/** The active selection extent to draw, resolved from the store slices. */
export interface SelectionRegion {
  startNs: number;
  endNs: number;
  mode: SelectionMode;
}

/**
 * The single source of "what box to show" (precedence order), pure over the two
 * slices so it is unit-testable:
 *   1. a live keyboard selection (Shift/Alt + arrows);
 *   2. else a live drag region/zoom that has crossed the 3px intent;
 *   3. else a retained region (selection.sidebarRange) - the persistent
 *      Shift selection that lives until the sidebar closes - UNLESS it covers
 *      the whole trace extent: the box exists to distinguish the analyzed
 *      sub-range, and a whole-trace analysis (the toolbar Flamegraph /
 *      Blocking Calls / Heap buttons retain [minTs, maxTs]) has no sub-range
 *      to distinguish - boxing everything just tints the page (issue #796);
 *   4. else the current issues-rail jump's range (selection.poiRange) - the
 *      marker for a POI the lanes draw no bar for. Last, because it is passive:
 *      an in-flight gesture or a retained analysis is what the user is doing
 *      NOW;
 *   5. else nothing (box hidden).
 * A "pan" drag draws no box (it moves the viewport, not a selection).
 */
export function activeSelectionRegion(
  transient: TransientSlice,
  selection: SelectionSlice,
  extent: { minTs: number; maxTs: number },
): SelectionRegion | null {
  const kb = transient.keyboardSelection;
  if (kb !== null) {
    return {
      startNs: Math.min(kb.startNs, kb.cursorNs),
      endNs: Math.max(kb.startNs, kb.cursorNs),
      mode: kb.kind === "zoom-select" ? "zoom" : "region",
    };
  }
  const drag = transient.drag;
  if (drag !== null && drag.kind !== "pan" && drag.moved) {
    return {
      startNs: Math.min(drag.startNs, drag.curNs),
      endNs: Math.max(drag.startNs, drag.curNs),
      mode: drag.kind === "zoom-select" ? "zoom" : "region",
    };
  }
  const retained = selection.sidebarRange;
  if (retained !== null) {
    if (retained.startNs <= extent.minTs && retained.endNs >= extent.maxTs) {
      return null;
    }
    return { startNs: retained.startNs, endNs: retained.endNs, mode: "region" };
  }
  const poi = selection.poiRange;
  if (poi !== null) {
    return { startNs: poi.startNs, endNs: poi.endNs, mode: "poi" };
  }
  return null;
}

/** Horizontal placement (CSS px, column-local) of the box for `region`. */
export interface SelectionBox {
  left: number;
  width: number;
}

/**
 * The track stack's vertical landmarks, column-local px, read from the DOM once
 * per render. Nulls mean "not mounted" (empty state, or a hidden ruler), which
 * the placement degrades through rather than guessing a pixel.
 */
export interface TrackStackMetrics {
  /** Top of the first track. */
  tracksTop: number | null;
  /** Bottom of the last track - grows as tracks are added, resized, expanded. */
  tracksBottom: number | null;
  /** Bottom of the time-ruler track. */
  rulerBottom: number | null;
  /** The scrollable column height: the last-resort bottom. */
  columnHeight: number;
}

/** Vertical placement (CSS px, column-local) of the box. */
export interface SelectionSpan {
  top: number;
  height: number;
}

/**
 * Box top/height from the track stack.
 *
 * The box covers the TRACKS and nothing else. It starts below the time ruler,
 * which is a reading surface rather than data - a box over it hides the very
 * labels that say which window you are looking at - and it ends at the last
 * track, so it neither stops short of the bottom track nor trails off into the
 * empty column below it. Measured per render, so adding, resizing, expanding or
 * hiding a track moves the box with it. Pure.
 */
export function selectionSpan(m: TrackStackMetrics): SelectionSpan {
  const top = m.rulerBottom ?? m.tracksTop ?? 0;
  const bottom = m.tracksBottom ?? m.columnHeight;
  return { top, height: Math.max(0, bottom - top) };
}

/**
 * Box left/width from a region and the shared layout. Both edges use the
 * layout's CLAMPED mapping so a selection extending outside the visible window
 * (a keyboard cursor panned past an edge) still renders inside the draw area,
 * never over the label gutter. Pure - the alignment invariant: the box maps
 * ns->x through the same layout the lanes use.
 */
export function selectionBox(region: SelectionRegion, layout: TimePanelLayout): SelectionBox {
  const x1 = layout.nsToPanelXClamped(region.startNs);
  const x2 = layout.nsToPanelXClamped(region.endNs);
  return { left: Math.min(x1, x2), width: Math.max(1, Math.abs(x2 - x1)) };
}

export interface MountedSelectionOverlay {
  dispose(): void;
}

/**
 * Mount the selection overlay against `store`, positioning one div inside the
 * shell's track column. Subscribes to the slices that move the box
 * (transient = the live gesture, viewport = pan/zoom re-maps ns->x, selection
 * = the retained range) and repositions it on each tick.
 */
export function mountSelectionOverlay(
  trackColumn: HTMLElement,
  store: ViewerStore,
): MountedSelectionOverlay {
  function ensureEl(): HTMLElement {
    let el = trackColumn.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`);
    if (el === null) {
      el = trackColumn.ownerDocument.createElement("div");
      el.className = OVERLAY_CLASS;
      el.setAttribute("aria-hidden", "true");
      trackColumn.appendChild(el);
    }
    return el;
  }

  /**
   * The box's own label. The box spans every lane, so its shape says nothing
   * about WHICH worker was descheduled, and its hard edges say nothing about
   * how little of the span the severity covers - the caption is where both
   * live. Dropped on a narrow box, where it would be clipped to noise.
   */
  function renderCaption(
    el: HTMLElement,
    highlight: PoiHighlight | null,
    width: number,
  ): void {
    let caption = el.querySelector<HTMLElement>(`.${CAPTION_CLASS}`);
    const text =
      highlight !== null && width >= CAPTION_MIN_WIDTH
        ? poiHighlightCaption(highlight)
        : "";
    if (text === "") {
      caption?.remove();
      return;
    }
    if (caption === null) {
      caption = el.ownerDocument.createElement("span");
      caption.className = CAPTION_CLASS;
      el.appendChild(caption);
    }
    caption.textContent = text;
  }

  function tracksEl(): HTMLElement | null {
    return trackColumn.querySelector<HTMLElement>(`.${TRACKS_CLASS}`);
  }

  /**
   * Column-local landmarks for `selectionSpan`, in the same scroll-content
   * coordinates the box is positioned in, so it scrolls with the tracks.
   *
   * Measured through `getBoundingClientRect`, NOT `offsetTop`: what the offset
   * parent is depends on whether some ancestor happens to be positioned, and
   * the track stack gained a positioned overlay child once already - which
   * silently reinterpreted every `offsetTop` here as tracks-local and slid the
   * box up over the ruler.
   *
   * The stack's bottom comes from the CONTAINER rather than its last child for
   * the same reason: a full-height overlay appended after the tracks is a
   * plausible last child and is not the bottom track.
   */
  function trackStackMetrics(tracks: HTMLElement | null): TrackStackMetrics {
    const origin =
      trackColumn.getBoundingClientRect().top - trackColumn.scrollTop;
    const top = (el: Element | null | undefined): number | null =>
      el instanceof HTMLElement
        ? Math.round(el.getBoundingClientRect().top - origin)
        : null;
    const bottom = (el: Element | null | undefined): number | null =>
      el instanceof HTMLElement
        ? Math.round(el.getBoundingClientRect().bottom - origin)
        : null;
    return {
      tracksTop: top(tracks),
      tracksBottom: bottom(tracks),
      rulerBottom: bottom(
        tracks?.querySelector<HTMLElement>(`[data-track-id="${RULER_TRACK_ID}"]`),
      ),
      columnHeight: trackColumn.scrollHeight,
    };
  }

  /**
   * Re-apply ONLY the vertical extent, from the DOM.
   *
   * Deliberately outside `assertInScheduledRender`: it reads no store state, so
   * it cannot paint a stale slice. That is what makes it safe to call from the
   * ResizeObserver below, which is the only way to follow the lanes resize
   * drag - that drag sizes its box imperatively and withholds the height from
   * the store until mouseup, precisely so a shell re-render cannot fight it, so
   * no store tick exists to ride.
   */
  function applySpan(el: HTMLElement, tracks: HTMLElement | null): void {
    const span = selectionSpan(trackStackMetrics(tracks));
    el.style.top = `${span.top}px`;
    el.style.height = `${span.height}px`;
  }

  // The stack's height changes without a store update (the lanes resize drag),
  // and with one that arrives before the DOM has reflowed. Observing the stack
  // itself covers both, and cannot loop: the box is a sibling of `.d9-tracks`,
  // so resizing it never resizes what is observed.
  let observed: HTMLElement | null = null;
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          const el = trackColumn.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`);
          if (el !== null && el.style.display !== "none") applySpan(el, observed);
        });

  /** Follow the CURRENT stack element: a reparse re-renders the track list, and
   *  an observer left on the detached one would go quiet. */
  function watchTracks(tracks: HTMLElement | null): void {
    if (resizeObserver === null || tracks === observed) return;
    if (observed !== null) resizeObserver.unobserve(observed);
    observed = tracks;
    if (tracks !== null) resizeObserver.observe(tracks);
  }

  function render(): void {
    assertInScheduledRender("selection-overlay render");
    const state = store.getState();
    const el = ensureEl();
    const region = activeSelectionRegion(
      state.transient,
      state.selection,
      state.viewport,
    );
    if (region === null) {
      el.style.display = "none";
      return;
    }
    // Read geometry once: column width + the lanes-matching scrollbar gutter,
    // then the shared layout - identical inputs to the lanes/overlay.
    const pw = trackColumn.clientWidth;
    const scrollbarW = lanesScrollbarWidth(trackColumn);
    const { viewStart, viewEnd } = state.viewport;
    if (viewEnd <= viewStart) {
      el.style.display = "none";
      return;
    }
    const layout = timePanelLayout({
      pw,
      scrollbarW,
      labelW: state.uiPrefs.labelWidth,
      viewStart,
      viewEnd,
    });
    const box = selectionBox(region, layout);
    el.classList.toggle(ZOOM_MODIFIER, region.mode === "zoom");
    el.classList.toggle(POI_MODIFIER, region.mode === "poi");
    el.style.left = `${box.left}px`;
    el.style.width = `${box.width}px`;
    el.style.display = "block";
    // Only the POI tier has a marker to name; a drag box labels nothing.
    renderCaption(
      el,
      region.mode === "poi" ? state.selection.poiRange : null,
      box.width,
    );
    const tracks = tracksEl();
    watchTracks(tracks);
    applySpan(el, tracks);
  }

  // Subscribe-only, like the lanes canvas and the crosshair overlay: the first
  // paint comes from the first store notification tick (the viewport update
  // that viewer-reconstruction's fitTrace dispatches on trace load), NOT a
  // synchronous render at mount. A direct render() here runs outside the
  // scheduler tick, which violates the "renders via subscriptions only"
  // contract and trips the dev assertion at boot. Nothing is drawable before
  // that first tick anyway
  // (no trace, no selection => the box is hidden).
  // `uiPrefs` is in the list for the box's GEOMETRY, not its range: the label
  // gutter width moves its left edge, and collapsing, reordering, resizing or
  // hiding a track changes the stack it is sized to. Without it the box keeps
  // the previous layout until some unrelated tick corrects it.
  const unsubscribe = store.subscribe(
    ["transient", "viewport", "selection", "uiPrefs"],
    () => render(),
  );

  return {
    dispose(): void {
      unsubscribe();
      resizeObserver?.disconnect();
      observed = null;
      trackColumn.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)?.remove();
    },
  };
}
