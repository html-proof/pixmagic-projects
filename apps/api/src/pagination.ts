/** The largest page any list returns. */
export const MAX_PAGE_SIZE = 100;

/**
 * Cursor paging for a list ordered newest first with the row id as the tie-breaker:
 * `?limit=&cursor=<id of the last row seen>`, answered as `{ <items>, nextCursor }`.
 *
 * Lenient, as the lists always were: a missing or unreadable `limit` means the list's own default,
 * anything else is clamped to 1-100 (and a fraction rounded down, which Prisma would refuse); an
 * unknown cursor finds nothing after it, so the page is empty.
 */
export function cursorPage(q: { limit?: string; cursor?: string }, defaultSize: number) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(q.limit) || defaultSize)));
  return {
    size,
    /** For findMany: one row more than the page, which says whether there is a next one. */
    args: { take: size + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) },
    /** The page itself, and the cursor of the next one (null on the last page). */
    split<T extends { id: string }>(rows: T[]) {
      const items = rows.slice(0, size);
      return { items, nextCursor: rows.length > size ? items[items.length - 1]!.id : null };
    },
  };
}
