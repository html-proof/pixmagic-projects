import type { Coord } from "@app/core";
import { HttpError } from "./context.js";

/** Fixed-window limiter. Throws 429 once `max` hits occur within `windowSec`. */
export async function limit(coord: Coord, key: string, max: number, windowSec: number) {
  const n = await coord.hit(key, windowSec);
  if (n > max) throw new HttpError(429, "Too many attempts. Please wait and try again.", "rate_limited");
}
