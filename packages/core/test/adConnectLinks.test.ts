import { describe, expect, it } from "vitest";
import {
  AD_CONNECT_LINK_TTL_S,
  createAdConnectLink,
  currentAdConnectLink,
  isAdConnectLinkToken,
  memoryCoord,
  openAdConnectLink,
  revokeAdConnectLink,
  useUpAdConnectLink,
} from "../src/index.js";

/**
 * Connect links (adConnections/links.ts) in the coordinator, without a database: one per store, opened
 * by its token only, replaced, turned off, ended by time, and used up by a connection. The API's
 * tests take the round trip through Facebook.
 */

const input = { workspaceId: "ws1", storeId: "st1", provider: "meta" as const, userId: "u1" };

describe("connect links", () => {
  it("opens by its token, which only the link carries, and the store's settings can show it again", async () => {
    const coord = memoryCoord();
    const { token, link } = await createAdConnectLink(coord, input);
    expect(isAdConnectLinkToken(token)).toBe(true);
    // The record is kept under the token's hash, never the token.
    expect(link.id).not.toContain(token);
    expect(await openAdConnectLink(coord, token)).toEqual(link);
    expect(await currentAdConnectLink(coord, "st1", "meta")).toEqual({ token, link });
    expect(await openAdConnectLink(coord, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await openAdConnectLink(coord, "short")).toBeNull();
  });

  it("a new link ends the store's last one; turning it off ends it", async () => {
    const coord = memoryCoord();
    const first = await createAdConnectLink(coord, input);
    const second = await createAdConnectLink(coord, input);
    expect(await openAdConnectLink(coord, first.token)).toBeNull();
    expect((await currentAdConnectLink(coord, "st1", "meta"))?.token).toBe(second.token);
    expect(await revokeAdConnectLink(coord, "st1", "meta")).toBe(true);
    expect(await openAdConnectLink(coord, second.token)).toBeNull();
    expect(await currentAdConnectLink(coord, "st1", "meta")).toBeNull();
    expect(await revokeAdConnectLink(coord, "st1", "meta")).toBe(false);
  });

  it("ends after its time", async () => {
    const coord = memoryCoord();
    const now = Date.now();
    const { token, link } = await createAdConnectLink(coord, input, now);
    expect(Date.parse(link.expiresAt)).toBe(now + AD_CONNECT_LINK_TTL_S * 1000);
    expect(await openAdConnectLink(coord, token, now + AD_CONNECT_LINK_TTL_S * 1000 - 1)).not.toBeNull();
    expect(await openAdConnectLink(coord, token, now + AD_CONNECT_LINK_TTL_S * 1000)).toBeNull();
  });

  it("used up by a connection: it says so when opened, and the settings no longer offer it", async () => {
    const coord = memoryCoord();
    const { token, link } = await createAdConnectLink(coord, input);
    await useUpAdConnectLink(coord, link, 2);
    expect(await openAdConnectLink(coord, token)).toMatchObject({ id: link.id, accounts: 2, usedAt: expect.any(String) });
    expect(await currentAdConnectLink(coord, "st1", "meta")).toBeNull();
    // Using up an older link leaves the store's newer one alone.
    const next = await createAdConnectLink(coord, input);
    await useUpAdConnectLink(coord, link, 1);
    expect((await currentAdConnectLink(coord, "st1", "meta"))?.token).toBe(next.token);
  });
});
