import { describe, expect, it } from "vitest";
import { cursorPage, pageLimit } from "../src/pagination.js";

describe("pagination", () => {
  it("normalizes untrusted limits before they reach Prisma", () => {
    for (const value of [undefined, "", "invalid", "0"]) expect(pageLimit(value, 30)).toBe(30);
    expect(pageLimit("2.8")).toBe(2);
    expect(pageLimit("-5")).toBe(1);
    expect(pageLimit("0.5")).toBe(1);
    expect(pageLimit("Infinity")).toBe(100);
    expect(pageLimit("1000")).toBe(100);
  });
  it("uses the last returned row as a cursor only when another row exists", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(cursorPage(rows, 2)).toEqual({ items: rows.slice(0, 2), nextCursor: "b" });
    expect(cursorPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
    expect(cursorPage([], 2)).toEqual({ items: [], nextCursor: null });
  });
});
