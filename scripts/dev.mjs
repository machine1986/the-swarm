// Starts backend (with watch) and Vite dev server together; Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  ["server", "npm", ["run", "dev", "--workspace", "server"]],
  ["client", "npm", ["run", "dev", "--workspace", "client"]],
].map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = name === "server" ? "\x1b[35m[server]\x1b[0m " : "\x1b[36m[client]\x1b[0m ";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
