import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Focus mode: the page alone, for long writing sessions. The workspace hides
 * its sidebar, toolbar and panels; the editor can keep the line being written
 * at the middle of the screen (typewriter scrolling).
 */

const TYPEWRITER_KEY = "lantern:focus:typewriter";
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
