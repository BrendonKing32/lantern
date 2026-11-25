import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemePicker } from "./components/ThemePicker";
import { getTheme, initTheme, setTheme } from "./theme";

describe("GitHub Dark theme", () => {
  let saved: Map<string, string>;
  let attributes: Map<string, string>;
  let browserColor: Map<string, string>;

  beforeEach(() => {
    saved = new Map();
    attributes = new Map();
    browserColor = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.stubGlobal("document", {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
      querySelector: (selector: string) => selector === 'meta[name="theme-color"]'
        ? { setAttribute: (name: string, value: string) => browserColor.set(name, value) }
        : null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers GitHub Dark and restores the selection after a reload", () => {
    initTheme();
    const defaultColor = browserColor.get("content");
    expect(renderToStaticMarkup(createElement(ThemePicker))).toContain(
      '<option value="github-dark">GitHub Dark</option>',
    );

    setTheme("github-dark");
    expect(getTheme()).toBe("github-dark");
    expect(attributes.get("data-theme")).toBe("github-dark");
    const selectedColor = browserColor.get("content");
    expect(selectedColor).not.toBe(defaultColor);
    expect(renderToStaticMarkup(createElement(ThemePicker))).toContain(
      '<option value="github-dark" selected="">GitHub Dark</option>',
    );

    attributes.clear();
    browserColor.clear();
    initTheme();
    expect(attributes.get("data-theme")).toBe("github-dark");
    expect(browserColor.get("content")).toBe(selectedColor);

    setTheme("lantern");
    expect(getTheme()).toBe("lantern");
    expect(attributes.has("data-theme")).toBe(false);
    expect(browserColor.get("content")).toBe(defaultColor);
  });

  it("applies GitHub Dark even when device storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => { throw new Error("storage blocked"); },
    });

    setTheme("github-dark");
    expect(attributes.get("data-theme")).toBe("github-dark");
    expect(browserColor.get("content")).toBeTruthy();
  });
});

describe("Clay theme", () => {
  let attributes: Map<string, string>;
  let browserColor: Map<string, string>;

  beforeEach(() => {
    const saved = new Map<string, string>();
    attributes = new Map();
    browserColor = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.stubGlobal("document", {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
      querySelector: (selector: string) => selector === 'meta[name="theme-color"]'
        ? { setAttribute: (name: string, value: string) => browserColor.set(name, value) }
        : null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("offers Clay and restores the selection after a reload", () => {
    expect(renderToStaticMarkup(createElement(ThemePicker))).toContain(
      '<option value="clay">Clay</option>',
    );

    setTheme("clay");
    expect(attributes.get("data-theme")).toBe("clay");
    expect(browserColor.get("content")).toBe("#262624");

    attributes.clear();
    initTheme();
    expect(getTheme()).toBe("clay");
    expect(attributes.get("data-theme")).toBe("clay");
  });
});
