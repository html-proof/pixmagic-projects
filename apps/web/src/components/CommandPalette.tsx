"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  /** Other words someone might type for it ("revenue" for Sales). */
  keywords?: string;
  go: () => void;
}

/** Every word typed has to appear somewhere in the item's label, group or keywords. */
function matches(item: PaletteItem, query: string): boolean {
  const hay = `${item.label} ${item.group} ${item.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * Jump to any part of the app by typing (Ctrl+K / ⌘K, or the search box in the top bar): the
 * dashboard's topics, the other areas and every settings page. A list to pick from, not a search
 * of the store's data.
 */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const shown = useMemo(() => items.filter((i) => matches(i, query)), [items, query]);
  const at = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.go();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (shown.length ? (Math.min(a, shown.length - 1) + 1) % shown.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (shown.length ? (Math.min(a, shown.length - 1) - 1 + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[at]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Group headings in the order the items come in.
  const groups: Array<{ name: string; items: Array<{ item: PaletteItem; index: number }> }> = [];
  shown.forEach((item, index) => {
    const g = groups.find((x) => x.name === item.group) ?? groups[groups.push({ name: item.group, items: [] }) - 1]!;
    g.items.push({ item, index });
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Go to">
      <div className="animate-fade absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="animate-rise relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" onKeyDown={onKey}>
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search aria-hidden className="h-5 w-5 shrink-0 text-muted" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search insights, pages and settings…"
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={shown[at] ? `${id}-${shown[at]!.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search insights, pages and settings"
          />
          <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted sm:block">Esc</kbd>
        </div>
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Places to go" className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
          {shown.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">Nothing called &ldquo;{query}&rdquo;. Try another word.</li>}
          {groups.map((g) => (
            <li key={g.name} role="presentation">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted" aria-hidden>{g.name}</p>
              <ul role="group" aria-label={g.name}>
                {g.items.map(({ item, index }) => {
                  const Icon = item.icon;
                  const on = index === at;
                  return (
                    <li
                      key={item.id}
                      id={`${id}-${item.id}`}
                      data-index={index}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(item)}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${on ? "bg-accent/10 text-text" : "text-text/85"}`}
                    >
                      <Icon aria-hidden className={`h-[18px] w-[18px] shrink-0 ${on ? "text-accent" : "text-muted"}`} strokeWidth={1.8} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {on && <CornerDownLeft aria-hidden className="h-4 w-4 shrink-0 text-muted" />}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
