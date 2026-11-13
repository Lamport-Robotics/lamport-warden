/** The program: `node sentinel/service/dist/sentinel.mjs`, configured by the environment (see main.ts). */
import { run } from "./main.js";

// A promise nobody was waiting on must not end the watching: it is logged and the process goes on. Anything
// thrown outside a promise leaves the process in an unknown state, so it ends and systemd starts it again.
process.on("unhandledRejection", (e) => { console.error("sentinel: an unhandled rejection", e); });
process.on("uncaughtException", (e) => { console.error("sentinel: an uncaught exception", e); process.exit(1); });

run(process.env).then((stop) => {
  const end = () => { void stop().then(() => process.exit(0)); };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}).catch((e) => { console.error(`sentinel: ${String((e as Error).message ?? e)}`); process.exit(1); });
