import { appendFileSync } from "node:fs";
import { acquireProxyStartLock } from "../../src/lib/proxy-start-lock";

const [home, eventsPath, label, holdText] = process.argv.slice(2);
if (!home || !eventsPath || !label) process.exit(2);
process.env.OPENCODEX_HOME = home;
const lock = await acquireProxyStartLock();
appendFileSync(eventsPath, `${label}:acquired:${Date.now()}\n`, "utf8");
await Bun.sleep(Number(holdText ?? "0"));
appendFileSync(eventsPath, `${label}:released:${Date.now()}\n`, "utf8");
lock.release();
