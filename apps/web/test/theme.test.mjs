import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * Light or dark (lib/theme.ts): what a device's stored choice means, which palette it shows, and
 * that the script run before the page paints follows the same rules. Also that the stylesheet's
 * dark rules follow the person's choice (<html data-theme>), never the device's setting alone.
 */
const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("require", "exports", outputText)((id) => assert.fail(`unexpected import ${id}`), exports);
  return exports;
};
const { DEVICE_DARK, otherTheme, parseThemeChoice, resolveTheme, THEME_KEY, THEME_SCRIPT } = await load("../src/lib/theme.ts");

test("a stored choice is light or dark; anything else follows the device", () => {
  assert.equal(parseThemeChoice("light"), "light");
  assert.equal(parseThemeChoice("dark"), "dark");
  for (const raw of [null, undefined, "", "system", "Dark", "<script>"]) assert.equal(parseThemeChoice(raw), "system");
});

test("a choice wins over the device's setting; no choice follows it", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("the top bar's button goes to the other palette", () => {
  assert.equal(otherTheme("light"), "dark");
  assert.equal(otherTheme("dark"), "light");
});

/** Run the page's script in a stand-in for the browser; returns the palette it put on <html>. */
function runScript({ stored = null, deviceDark = false, storage = "works", matchMedia = true } = {}) {
  const attrs = {};
  const localStorage = {
    getItem(key) {
      if (storage === "blocked") throw new Error("SecurityError");
      assert.equal(key, THEME_KEY);
      return stored;
    },
  };
  const media = (query) => {
    assert.equal(query, DEVICE_DARK);
    return { matches: deviceDark };
  };
  const document = { documentElement: { setAttribute: (name, value) => (attrs[name] = value) } };
  new Function("localStorage", "matchMedia", "document", THEME_SCRIPT)(localStorage, matchMedia ? media : undefined, document);
  return attrs["data-theme"];
}

test("the script run before the page paints follows the same rules", () => {
  for (const stored of ["light", "dark", null, "system", "nonsense"]) {
    for (const deviceDark of [true, false]) {
      assert.equal(runScript({ stored, deviceDark }), resolveTheme(parseThemeChoice(stored), deviceDark), `stored ${stored}, device ${deviceDark ? "dark" : "light"}`);
    }
  }
});

test("blocked storage is nothing saved, and a browser without matchMedia is light", () => {
  assert.equal(runScript({ storage: "blocked", deviceDark: true }), "dark");
  assert.equal(runScript({ storage: "blocked", deviceDark: false }), "light");
  assert.equal(runScript({ matchMedia: false }), "light");
  assert.equal(runScript({ stored: "dark", matchMedia: false }), "dark");
});

test("the stylesheet's dark rules follow the choice, not the device's setting alone", async () => {
  const css = await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8");
  // A rule on the device's setting would ignore someone who chose the other palette.
  assert.equal(css.includes("prefers-color-scheme"), false, "globals.css reads the device's setting directly");
  assert.match(css, /@custom-variant dark\b/);
  assert.match(css, /:root\[data-theme="dark"\]/);
});
