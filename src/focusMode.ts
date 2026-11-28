import { EditorState, RangeSetBuilder, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * Focus mode: the page alone, for long writing sessions. The workspace hides
 * its sidebar, toolbar and panels; the editor can keep the line being written
 * at the middle of the screen (typewriter scrolling).
 */

const TYPEWRITER_KEY = "lantern:focus:typewriter";
const DIM_KEY = "lantern:focus:dim";
const FOCUS_KEY = "lantern:focus";

/** Typewriter scrolling is on unless the writer turned it off on this device. */
export function typewriterEnabled(): boolean {
  try {
    return localStorage.getItem(TYPEWRITER_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setTypewriterEnabled(on: boolean): void {
  try {
    localStorage.setItem(TYPEWRITER_KEY, on ? "on" : "off");
  } catch {
    // Storage can be unavailable (private windows); the setting just isn't kept.
  }
}

/** Paragraph dimming is on unless the writer turned it off on this device. */
export function dimmingEnabled(): boolean {
  try {
    return localStorage.getItem(DIM_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDimmingEnabled(on: boolean): void {
  try {
    localStorage.setItem(DIM_KEY, on ? "on" : "off");
  } catch {
    // Not kept beyond this page.
  }
}

/** Whether this tab was in focus mode, so a reload doesn't throw the writer out of it. */
export function focusRemembered(): boolean {
  try {
    return sessionStorage.getItem(FOCUS_KEY) === "on";
  } catch {
    return false;
  }
}

export function rememberFocus(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FOCUS_KEY, "on");
    else sessionStorage.removeItem(FOCUS_KEY);
  } catch {
    // Not kept; focus mode still works for this page.
  }
}

/** Ctrl+Alt+F (⌘⌥F on a Mac), matching Lantern's Ctrl+Alt+M for notes. */
export function isFocusShortcut(e: Pick<KeyboardEvent, "code" | "key" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey">): boolean {
  // On a Mac, Option changes e.key (⌥F types “ƒ”), so match the physical key too.
  const isF = e.code === "KeyF" || e.key.toLowerCase() === "f";
  return isF && e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey);
}

/**
 * Whether a transaction should bring the cursor back to the middle: typing,
 * deleting, undo and keyboard movement, but not a click (the page shouldn't
 * jump under the pointer) and not a selection being dragged out.
 */
export function recentres(tr: Transaction): boolean {
  if (!tr.state.selection.main.empty) return false;
  if (tr.isUserEvent("select.pointer")) return false;
  return (
    tr.isUserEvent("input") ||
    tr.isUserEvent("delete") ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo") ||
    tr.isUserEvent("select")
  );
}

/** Keeps the line being written at the middle of the screen. */
export function typewriterScrolling(): Extension {
  return EditorState.transactionExtender.of((tr) =>
    recentres(tr) ? { effects: EditorView.scrollIntoView(tr.state.selection.main.head, { y: "center" }) } : null,
  );
}

type WakeLock = { release: () => Promise<void> };

/**
 * Keep the screen awake while focus mode is on, so a long pause to think
 * doesn't dim the page. Returns a function that lets the screen sleep again.
 * Browsers drop the lock when the tab is hidden, so it's taken again on return.
 */
export function keepAwake(): () => void {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLock> } }).wakeLock;
  if (!wakeLock) return () => {};
  let lock: WakeLock | null = null;
  let stopped = false;
  const take = () => {
    if (stopped || document.visibilityState !== "visible") return;
    wakeLock.request("screen").then(
      (l) => {
        if (stopped) void l.release().catch(() => {});
        else lock = l;
      },
      () => {}, // Refused (battery saver, permissions policy): carry on without it.
    );
  };
  take();
  document.addEventListener("visibilitychange", take);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", take);
    void lock?.release().catch(() => {});
    lock = null;
  };
}

const isBlank = (doc: Text, line: number) => doc.line(line).text.trim() === "";

/**
 * The lines of the paragraph (or paragraphs) the selection touches: the run
 * of non-blank lines around it, bounded by blank lines. On a blank line,
 * just that line, so the page around a fresh gap stays dim.
 */
export function activeParagraph(doc: Text, from: number, to: number): { first: number; last: number } {
  let first = doc.lineAt(from).number;
  let last = doc.lineAt(to).number;
  if (first === last && isBlank(doc, first)) return { first, last };
  while (first > 1 && !isBlank(doc, first - 1)) first--;
  while (last < doc.lines && !isBlank(doc, last + 1)) last++;
  return { first, last };
}

const dimmed = Decoration.line({ class: "cm-dimmed" });

function dimDecorations(view: EditorView): DecorationSet {
  const { doc, selection } = view.state;
  const { first, last } = activeParagraph(doc, selection.main.from, selection.main.to);
  const builder = new RangeSetBuilder<Decoration>();
  // Only the lines on screen are decorated, so long chapters stay quick.
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (line.number < first || line.number > last) builder.add(line.from, line.from, dimmed);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Dims every paragraph but the one being written. */
export function paragraphDimming(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = dimDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = dimDecorations(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
