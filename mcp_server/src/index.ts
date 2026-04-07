import { loadConfig } from "./config.js";
import { startHttpServer } from "./http/server.js";
import { closeSharedBrowser } from "./tools/crawlRendered.js";
import { log } from "./util/log.js";

const config = loadConfig();

async function shutdown(signal: string): Promise<void> {
  log.info("process.shutdown", { signal });
  await closeSharedBrowser().catch((error: unknown) => {
    log.warn("browser.close_failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
  });
  process.exit(0);
}

async function main(): Promise<void> {
  await startHttpServer(config);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  log.error("process.fatal", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  process.exit(1);
});
