import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { BlobStore } from "@app/core";

/**
 * Large webhook bodies and WhatsApp media waiting to be sent, as files under one folder, for
 * bizinsights on a server of its own (server.ts): the `payloads` bucket on AWS (s3Blobs.ts). Both
 * are transient: the job that reads one deletes it, and prune() removes anything left after 7 days,
 * as the bucket's lifecycle rule does. The API (which writes webhook bodies) and the worker (which
 * reads them) share the folder through one volume.
 *
 * Keys are the app's own ("webhooks/<event>-<token>.json", "wapp-media/<id>"); anything that could
 * leave the folder is refused. Writes go to a temporary name first, so a reader never sees half a file.
 */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function blobPath(root: string, key: string): string {
  if (!KEY.test(key) || key.split("/").some((part) => part === "." || part === "..")) throw new Error("Unusable blob key");
  const base = resolve(root);
  const path = resolve(base, ...key.split("/"));
  if (!path.startsWith(base + sep)) throw new Error("Unusable blob key");
  return path;
}

export function fsBlobs(root: string): BlobStore & { prune(olderThanMs: number, nowMs?: number): Promise<number> } {
  return {
    async put(key, value) {
      const path = blobPath(root, key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, value, "utf8");
      await rename(tmp, path);
    },
    async get(key) {
      try {
        return await readFile(blobPath(root, key), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await rm(blobPath(root, key), { force: true });
    },
    async prune(olderThanMs, nowMs = Date.now()) {
      let removed = 0;
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          throw err;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile() && nowMs - (await stat(p)).mtimeMs > olderThanMs) {
            await rm(p, { force: true });
            removed++;
          }
        }
      };
      await walk(resolve(root));
      return removed;
    },
  };
}
