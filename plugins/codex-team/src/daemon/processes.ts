import fs from "node:fs";
import { execFileSync } from "node:child_process";

export type ProcessCommandSource = "proc" | "ps" | "powershell" | "wmic" | "tasklist" | null;

export interface ProcessCommandInspection {
  commandLine: string | null;
  source: ProcessCommandSource;
  reliable: boolean;
}

function readLinuxCmdline(pid: number): ProcessCommandInspection {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const commandLine = raw.toString("utf8").replace(/\0/g, " ").trim() || null;
    return { commandLine, source: "proc", reliable: true };
  } catch {
    return { commandLine: null, source: null, reliable: false };
  }
}

function readPsCommand(pid: number): ProcessCommandInspection {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const commandLine = raw.trim();
    return { commandLine: commandLine.length > 0 ? commandLine : null, source: "ps", reliable: true };
  } catch {
    return { commandLine: null, source: null, reliable: false };
  }
}

function readWindowsCommand(pid: number): ProcessCommandInspection {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p -and $null -ne $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }`;
  for (const bin of ["powershell.exe", "powershell", "pwsh"]) {
    try {
      const raw = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const commandLine = raw.trim();
      if (commandLine.length > 0) return { commandLine, source: "powershell", reliable: true };
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
    const commandLine = line?.slice("CommandLine=".length).trim() ?? "";
    if (commandLine.length > 0) return { commandLine, source: "wmic", reliable: true };
  } catch {
    // try tasklist fallback next
  }
  try {
    const raw = execFileSync("tasklist", ["/FO", "LIST", "/NH", "/FI", `PID eq ${pid}`], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => /^Image Name:/i.test(entry));
    const commandLine = line?.replace(/^Image Name:\s*/i, "").trim() ?? "";
    if (commandLine.length > 0) return { commandLine, source: "tasklist", reliable: false };
  } catch {
    // give up
  }
  return { commandLine: null, source: null, reliable: false };
}

export function inspectProcessCommandLine(pid: number): ProcessCommandInspection {
  if (!Number.isFinite(pid) || pid <= 0) return { commandLine: null, source: null, reliable: false };
  if (process.platform === "linux") return readLinuxCmdline(pid);
  if (process.platform === "darwin" || process.platform === "freebsd") return readPsCommand(pid);
  if (process.platform === "win32") return readWindowsCommand(pid);
  return { commandLine: null, source: null, reliable: false };
}

export function readProcessCommandLine(pid: number): string | null {
  return inspectProcessCommandLine(pid).commandLine;
}

export function inspectCodexAppServerProcess(pid: number): "match" | "mismatch" | "unknown" {
  const inspection = inspectProcessCommandLine(pid);
  if (!inspection.commandLine) return "unknown";
  if (looksLikeCodexAppServerCommand(inspection.commandLine)) return "match";
  if (!inspection.reliable) return "unknown";
  return "mismatch";
}

export function isLikelyCodexAppServerProcess(pid: number): boolean {
  return inspectCodexAppServerProcess(pid) === "match";
}

export function isLikelyCodexTeamDaemonProcess(pid: number): boolean {
  const commandLine = readProcessCommandLine(pid);
  return commandLine !== null && commandLine.includes("--daemon-internal");
}

function looksLikeCodexAppServerCommand(commandLine: string): boolean {
  return commandLine.includes("app-server") && (commandLine.includes("codex") || commandLine.includes("codex-cli-bin"));
}
