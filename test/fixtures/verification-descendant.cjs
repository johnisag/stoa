const { spawn } = require("child_process");
const { writeFileSync } = require("fs");

const mode = process.argv[2];
const pidFile = process.argv[3];
if (!mode || !pidFile) process.exit(2);

const detached = mode.startsWith("detached-");
const trigger = detached ? mode.slice("detached-".length) : mode;

// The detached variant calls setsid through Node's POSIX detached spawn path,
// escaping the verification process group while keeping this fixture as PPID.
const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { detached, stdio: "ignore" }
);
if (!descendant.pid) process.exit(3);
if (detached) descendant.unref();
writeFileSync(pidFile, String(descendant.pid));
writeFileSync(`${pidFile}.root`, String(process.pid));

if (trigger === "output") {
  process.stdout.write("x".repeat(256 * 1024));
}

setInterval(() => {}, 1000);
