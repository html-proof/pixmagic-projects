import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * The short menu's rules (lib/menu.ts) and where the look around puts its card (lib/tour.ts): when
 * the sidebar folds, which groups show their pages, what a device remembers, and a card that never
 * leaves the window.
 */
const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("require", "exports", outputText)((id) => assert.fail(`unexpected import ${id}`), exports);
  return exports;
};
const { FOLD_FROM, folds, groupFolds, groupOpen, parseOpenGroups, toggleGroup } = await load("../src/lib/menu.ts");
const { placeCard, TOUR_STEPS } = await load("../src/lib/tour.ts");

test("the menu folds only in the short layout, and only when it is long enough to be worth it", () => {
  assert.equal(folds("short", 22), true);
  assert.equal(folds("short", FOLD_FROM), true);
  // A member shown a handful of pages, or a shared dashboard: the plain list.
  assert.equal(folds("short", FOLD_FROM - 1), false);
  // "Show every page" was chosen on this device.
  assert.equal(folds("full", 22), false);
});

test("a group of one page doesn't fold: the page is shown as it is", () => {
  assert.equal(groupFolds(0), false);
  assert.equal(groupFolds(1), false);
  assert.equal(groupFolds(2), true);
});

test("the open groups a device stored are read back, and anything unknown is dropped", () => {
  assert.deepEqual(parseOpenGroups(null), []);
  assert.deepEqual(parseOpenGroups(""), []);
  assert.deepEqual(parseOpenGroups("store,settings"), ["store", "settings"]);
  assert.deepEqual(parseOpenGroups("store,<script>,store,nope"), ["store"]);
});

test("opening and closing a group changes only that group", () => {
  assert.deepEqual(toggleGroup([], "store"), ["store"]);
  assert.deepEqual(toggleGroup(["store", "settings"], "store"), ["settings"]);
  assert.deepEqual(toggleGroup(["settings"], "reports"), ["settings", "reports"]);
});

test("a group shows its pages when it was opened, or when it holds the page being looked at", () => {
  assert.equal(groupOpen("store", [], false), false);
  assert.equal(groupOpen("store", ["store"], false), true);
  // The current page is never hidden in its own menu…
  assert.equal(groupOpen("store", [], true), true);
  // …until the group is closed by hand on that page.
  assert.equal(groupOpen("store", [], true, ["store"]), false);
  assert.equal(groupOpen("store", ["store"], true, ["store"]), false);
  // Another group closed there says nothing about this one.
  assert.equal(groupOpen("store", [], true, ["settings"]), true);
});

const view = { width: 1280, height: 800 };
const card = { width: 352, height: 180 };
const onScreen = (p) => p.top >= 12 && p.left >= 12 && p.top + card.height <= view.height - 12 && p.left + card.width <= view.width - 12;

test("the tour's card goes under what it points at when there is room", () => {
  const p = placeCard({ top: 100, left: 300, width: 400, height: 120 }, card, view);
  assert.deepEqual(p, { top: 232, left: 300 });
});

test("with no room under, the card goes over; beside something as tall as the window", () => {
  // The help button, bottom right.
  const over = placeCard({ top: 720, left: 1200, width: 68, height: 68 }, card, view);
  assert.equal(over.top, 720 - 12 - card.height);
  assert.ok(onScreen(over));
  // The sidebar: the window's whole height, at the left edge.
  const beside = placeCard({ top: 4, left: 4, width: 244, height: 792 }, card, view);
  assert.deepEqual(beside, { top: 12, left: 260 });
});

test("the card is wholly on the window whatever it points at", () => {
  const phone = { width: 375, height: 667 };
  const small = { width: 351, height: 190 };
  for (const target of [
    { top: 0, left: 0, width: 375, height: 667 },
    { top: 8, left: 4, width: 44, height: 44 },
    { top: 600, left: 300, width: 68, height: 60 },
    { top: 200, left: -40, width: 500, height: 300 },
  ]) {
    const p = placeCard(target, small, phone);
    assert.ok(p.top >= 12 && p.left >= 12, JSON.stringify({ target, p }));
    assert.ok(p.top + small.height <= phone.height - 12 && p.left + small.width <= phone.width - 12, JSON.stringify({ target, p }));
  }
});

test("every step of the tour names something to point at and says what it is for", () => {
  assert.ok(TOUR_STEPS.length >= 4);
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
  for (const s of TOUR_STEPS) {
    assert.ok(s.targets.length > 0, s.id);
    assert.ok(s.title.length > 0 && s.body.length > 20, s.id);
  }
});
