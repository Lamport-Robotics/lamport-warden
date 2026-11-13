/** The program: `node sentinel/service/dist/sentinel.mjs`, configured by the environment (see main.ts). */
import { run } from "./main.js";

run(process.env).then((stop) => {
  const end = () => { void stop().then(() => process.exit(0)); };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}).catch((e) => { console.error(`sentinel: ${String((e as Error).message ?? e)}`); process.exit(1); });
