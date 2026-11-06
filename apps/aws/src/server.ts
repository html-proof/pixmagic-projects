import { logger } from "@app/core";
import { main } from "./selfhost.js";

// The self-hosted server's entry (bundled as server.mjs): `node server.mjs web|worker`. The code is
// in selfhost.ts, which tests import without starting anything.
main(process.argv.slice(2)).catch((err: unknown) => {
  logger.error({ err }, "could not start");
  process.exit(1);
});
