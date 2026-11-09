// Colour themes. Each one is a set of CSS tokens in styles.css, switched by
// data-theme on <html>. The choice lives on this device only.

export const THEMES = [
  { id: "lantern", name: "Lantern", night: "#1b2230" },
  { id: "hearth", name: "Hearth", night: "#1f1814" },
  { id: "pine", name: "Pine", night: "#141d1a" },
  { id: "tide", name: "Tide", night: "#0f1d24" },
  { id: "shadow", name: "Shadow", night: "#1b1725" },
  { id: "parchment", name: "Parchment", night: "#f4ecdc" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "lantern:theme";
const listeners = new Set<(t: ThemeId) => void>();

function isTheme(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

export function getTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (isTheme(v)) return v;
  } catch {
    // storage blocked: fall through to the default
  }
  return "lantern";
}

function apply(id: ThemeId) {
  const root = document.documentElement;
  if (id === "lantern") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
  const night = THEMES.find((t) => t.id === id)!.night;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", night);
}

export function setTheme(id: ThemeId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // still apply it for this visit
  }
  apply(id);
  listeners.forEach((l) => l(id));
}

export function onThemeChange(l: (t: ThemeId) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function initTheme() {
  apply(getTheme());
}
