import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(".");

export function zkvmHostInvocation(guestArgs) {
  const bin = process.env.ZK_WALDO_HOST_BIN;
  if (bin) {
    return { command: bin, args: guestArgs, cwd: root };
  }
  return {
    command: "cargo",
    args: ["run", "-p", "zk-waldo-zkvm-host", "--", ...guestArgs],
    cwd: root,
  };
}

export function runZkvmHost(guestArgs, { extraEnv = {}, timeoutMs = 10 * 60 * 1000 } = {}) {
  const { command, args, cwd } = zkvmHostInvocation(guestArgs);
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, RISC0_PROVER: process.env.RISC0_PROVER ?? "ipc", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectCommand(new Error("RISC Zero host command timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand(stdout);
      } else {
        rejectCommand(
          new Error(
            lastUsefulLine(stderr || stdout) || `host exited with code ${code}`,
          ),
        );
      }
    });
  });
}

function lastUsefulLine(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}
