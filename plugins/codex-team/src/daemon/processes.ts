import fs from "node:fs";
import { execFileSync } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  commandLine: string | null;
  startTime: string | null;
}

function readLinuxCmdline(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").replace(/\0/g, " ").trim() || null;
  } catch {
    return null;
  }
}

function readLinuxStartTime(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = raw.lastIndexOf(")");
    if (lastParen < 0) return null;
    const rest = raw.slice(lastParen + 2).trim().split(/\s+/);
    const startTime = rest[19];
    return typeof startTime === "string" && startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}

function readPsCommand(pid: number): string | null {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const cmd = raw.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

function readPsStartTime(pid: number): string | null {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const startTime = raw.trim();
    return startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}

function readWindowsCommand(pid: number): string | null {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p -and $null -ne $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }`;
  for (const bin of ["powershell.exe", "powershell", "pwsh"]) {
    try {
      const raw = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const cmd = raw.trim();
      if (cmd.length > 0) return cmd;
    } catch {
      // try next shell
    }
  }
  try {
    const raw = execFileSync("wmic", ["process", "where", `processid=${pid}`, "get", "CommandLine", "/value"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("CommandLine="));
    const cmd = line?.slice("CommandLine=".length).trim() ?? "";
    if (cmd.length > 0) return cmd;
  } catch {
    // give up
  }
  return null;
}

function readWindowsStartTime(pid: number): string | null {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p -and $null -ne $p.CreationDate) { [Console]::Out.Write($p.CreationDate) }`;
  for (const bin of ["powershell.exe", "powershell", "pwsh"]) {
    try {
      const raw = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const startTime = raw.trim();
      if (startTime.length > 0) return startTime;
    } catch {
      // try next shell
    }
  }
  try {
    const raw = execFileSync("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("CreationDate="));
    const startTime = line?.slice("CreationDate=".length).trim() ?? "";
    return startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}

export function readProcessCommandLine(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxCmdline(pid);
  if (process.platform === "darwin" || process.platform === "freebsd") return readPsCommand(pid);
  if (process.platform === "win32") return readWindowsCommand(pid);
  return null;
}

export function readProcessStartTime(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxStartTime(pid);
  if (process.platform === "darwin" || process.platform === "freebsd") return readPsStartTime(pid);
  if (process.platform === "win32") return readWindowsStartTime(pid);
  return null;
}

export function readProcessIdentity(pid: number): ProcessIdentity {
  return {
    pid,
    commandLine: readProcessCommandLine(pid),
    startTime: readProcessStartTime(pid),
  };
}

export function isLikelyCodexAppServerProcess(pid: number): boolean {
  const cmd = readProcessCommandLine(pid);
  if (!cmd) return false;
  return cmd.includes("app-server") && (cmd.includes("codex") || cmd.includes("codex-cli-bin"));
}

export function isLikelyCodexTeamDaemonProcess(pid: number): boolean {
  const cmd = readProcessCommandLine(pid);
  return cmd !== null && cmd.includes("--daemon-internal");
}
