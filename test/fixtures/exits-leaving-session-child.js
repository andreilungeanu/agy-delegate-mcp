// Starts a child in its own session (detached: setsid on POSIX), as agy runs each shell command,
// writes its pid to argv[2], then exits by itself after argv[3] ms.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(process.argv[2], `${child.pid}\n`);
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), Number(process.argv[3] || 400));
