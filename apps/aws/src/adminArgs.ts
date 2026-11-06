import { isAction, type Action } from "./actions.js";

/** The admin command's arguments (admin.ts): `<command> [positional...] [--flag [value]...]`. */
export function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | true> } {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { command, positional, flags };
}

export function toAction(command: string, flags: Record<string, string | true>): Action | null {
  if (!isAction(command)) return null;
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const days = str("days");
  return {
    action: command,
    shop: str("shop"),
    days: days === undefined ? undefined : Number(days),
    dryRun: flags["dry-run"] === true,
    dateFrom: str("from"),
    dateTo: str("to"),
  };
}
