/** Clamp untrusted query limits to an integer accepted by database clients. */
export function pageLimit(value: string | undefined, fallback = 50): number {
  const parsed = Number(value);
  return Number.isNaN(parsed) || parsed === 0
    ? fallback
    : Math.min(100, Math.max(1, Math.trunc(parsed)));
}

/** Query one extra row to determine whether the client can load another page. */
export function cursorPage<T extends { id: string }>(rows: T[], take: number) {
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? items[items.length - 1]!.id : null };
}
