import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve as pathResolve, join } from "node:path";
import { platform, tmpdir } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxProvider, SandboxConfig } from "./types.ts";
import { stripTrailingSep } from "./guard.ts";
import { expandGlob, globToSubtreeRegexSource, isGlob } from "./glob.ts";

function findBinary(name: string): boolean {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const searchDirs = [...pathDirs, "/usr/bin", "/usr/sbin", "/bin", "/sbin"];
  const seen = new Set<string>();
  return searchDirs.some((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return existsSync(`${dir}/${name}`);
  });
}

// ─── macOS sandbox-exec ────────────────────────────────────────────────────

class SandboxExecProvider implements SandboxProvider {
  readonly name = "sandbox-exec";
  private _profileCache = new Map<string, string>();

  available(): boolean {
    return platform() === "darwin" && findBinary("sandbox-exec");
  }

  wrap(inner: BashOperations, _cwd: string, config: SandboxConfig): BashOperations {
    const key = JSON.stringify([config.allowNetwork, config.writable, config.deny, config.denyWrite]);
    let profile = this._profileCache.get(key);
    if (!profile) {
      profile = buildSandboxExecProfile(config);
      this._profileCache.set(key, profile);
    }

    return {
      ...inner,
      exec(command, cwd, options) {
        return spawnSandboxedCommand("sandbox-exec", ["-p", profile], command, cwd, options);
      },
    };
  }

}

function escapeSbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** SBPL filter for a path (itself + subtree) or glob. */
function sbplFilter(p: string): string {
  if (!isGlob(p)) return `(subpath "${escapeSbpl(p)}")`;
  // #"..." regex literals keep backslashes verbatim, so only a quote would break them.
  if (p.includes('"')) throw new Error(`pi-sandbox: glob must not contain '"': ${p}`);
  return `(regex #"${globToSubtreeRegexSource(p)}")`;
}

export function buildSandboxExecProfile(config: SandboxConfig): string {
  const lines = [
    "(version 1)",
    "(deny default (with message \"pi-sandbox: operation not permitted\"))",
    "; global read-only filesystem",
    "(allow file-read*)",
    "; child processes inherit this policy",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow signal (target children))",
    "; /dev/null writes only",
    "(allow file-write-data",
    "  (require-all",
    '    (path "/dev/null")',
    "    (vnode-type CHARACTER-DEVICE)))",
    "; device access",
    '(allow file-write* (path-prefix "/dev/tty"))',
    '(allow file-ioctl  (path-prefix "/dev/tty"))',
    '(allow file-write* (path "/dev/dtracehelper"))',
    '(allow file-write* (path "/dev/autofs_nowait"))',
  ];

  lines.push("; writable paths");
  for (const p of config.writable) lines.push(`(allow file-write* ${sbplFilter(p)})`);

  lines.push("; write-protected paths");
  for (const p of config.denyWrite) lines.push(`(deny file-write* ${sbplFilter(p)})`);

  lines.push("; denied paths (last so they win)");
  for (const p of config.deny) lines.push(`(deny file-read* file-write* ${sbplFilter(p)})`);

  lines.push(
    "; mach services — missing entries cause hangs",
    "(allow mach-lookup",
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.opendirectoryd.api")',
    '  (global-name "com.apple.system.opendirectoryd.membership")',
    '  (global-name "com.apple.bsd.dirhelper")',
    '  (global-name "com.apple.cfprefsd.daemon")',
    '  (global-name "com.apple.cfprefsd.agent")',
    '  (global-name "com.apple.SecurityServer"))',
    "; hardware + kernel info",
    "(allow sysctl-read)",
  );

  if (config.allowNetwork) {
    lines.push(
      "; network access",
      "(allow network*)",
      "(allow system-socket)",
      "(allow mach-lookup",
      '  (global-name "com.apple.mDNSResponder")',
      '  (global-name "com.apple.mDNSResponderHelper"))',
    );
  }

  return lines.join("\n");
}

// ─── Linux bubblewrap ──────────────────────────────────────────────────────

// Intentionally excludes /var — bind-mounting the entire tree (/var/log, /var/cache, /var/lib)
// adds seconds of startup delay and significant memory pressure on many distros.
// /var/run and /var/lock are symlinks to /run (already bound above).
const SYSTEM_RO_BINDS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/sbin",
  "/run",
];

class BubblewrapProvider implements SandboxProvider {
  readonly name = "bubblewrap";

  available(): boolean {
    return platform() === "linux" && findBinary("bwrap");
  }

  wrap(inner: BashOperations, workspaceDir: string, config: SandboxConfig): BashOperations {
    return {
      ...inner,
      exec(command, cwd, options) {
        const setup = buildBwrapSetup(cwd, config, workspaceDir);
        return spawnSandboxedCommand("bwrap", setup.args, command, cwd, options, setup.cleanup);
      },
    };
  }
}

export function buildBwrapSetup(
  cwd: string,
  config: SandboxConfig,
  workspaceDir: string,
): { args: string[]; cleanup: () => void } {
  const args: string[] = [];
  const cleanupDirs: string[] = [];

  args.push("--unshare-all");
  args.push("--die-with-parent");
  if (config.allowNetwork) {
    args.push("--share-net");
  }

  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  const bindMounted = new Set<string>();

  for (const dir of SYSTEM_RO_BINDS) {
    if (existsSync(dir)) {
      args.push("--ro-bind", dir, dir);
      bindMounted.add(stripTrailingSep(dir));
    }
  }

  // Globs are expanded against the current filesystem at exec time.
  const expand = (list: string[]) => list.flatMap(expandGlob).filter((p) => existsSync(p));

  for (const p of expand(config.writable)) {
    args.push("--bind", p, p);
    bindMounted.add(stripTrailingSep(p));
  }

  args.push("--tmpfs", "/tmp");

  // always mount workspace as read-only if not already covered
  const ws = stripTrailingSep(pathResolve(workspaceDir));
  if (existsSync(workspaceDir) && !isUnderBindRoot(ws, bindMounted)) {
    args.push("--ro-bind", workspaceDir, workspaceDir);
    bindMounted.add(ws);
  }

  // Order matters — later mounts shadow earlier ones, so deny overlays go last.
  for (const p of expand(config.denyWrite)) {
    args.push("--ro-bind", p, p);
  }

  for (const p of expand(config.deny)) {
    const overlay = createDenyOverlay(p);
    cleanupDirs.push(overlay.cleanupDir);
    args.push("--ro-bind", overlay.source, p);
  }

  const chdirTarget = resolveChdirTarget(cwd, bindMounted, workspaceDir);
  args.push("--chdir", chdirTarget);
  return {
    args,
    cleanup: () => {
      for (const dir of cleanupDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort cleanup
        }
      }
    },
  };
}

function createDenyOverlay(targetPath: string): { source: string; cleanupDir: string } {
  const cleanupDir = mkdtempSync(join(tmpdir(), "pi-sandbox-deny-"));
  const stat = statSync(targetPath);

  if (stat.isDirectory()) {
    const emptyDir = join(cleanupDir, "empty-dir");
    mkdirSync(emptyDir);
    chmodSync(emptyDir, 0o000);
    return { source: emptyDir, cleanupDir };
  }

  const emptyFile = join(cleanupDir, "empty-file");
  writeFileSync(emptyFile, "");
  chmodSync(emptyFile, 0o000);
  return { source: emptyFile, cleanupDir };
}

function isUnderBindRoot(target: string, roots: Set<string>): boolean {
  if (roots.has(target)) return true;
  for (const r of roots) {
    if (target.startsWith(r + "/")) return true;
  }
  return false;
}

function resolveChdirTarget(cwd: string, bindMounted: Set<string>, workspaceDir: string): string {
  const absCwd = pathResolve(cwd);
  const roots = new Set([...bindMounted, "/tmp", "/proc", "/dev", stripTrailingSep(pathResolve(workspaceDir))]);
  const normCwd = stripTrailingSep(absCwd);

  if (roots.has(normCwd)) return absCwd;
  for (const root of roots) {
    if (normCwd.startsWith(root + "/")) {
      return absCwd;
    }
  }
  console.warn(`[pi-sandbox] bwrap: cwd "${absCwd}" is not bind-mounted, using /tmp instead`);
  return "/tmp";
}

// ─── Noop fallback ─────────────────────────────────────────────────────────

class NoopProvider implements SandboxProvider {
  readonly name = "none";

  available(): boolean {
    return true;
  }

  wrap(inner: BashOperations, _cwd: string, _config: SandboxConfig): BashOperations {
    return inner;
  }
}

function spawnSandboxedCommand(
  binary: string,
  args: string[],
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
  cleanup?: () => void,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanedUp = false;
    const runCleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cleanup?.();
    };

    const child = spawn(binary, [...args, "--", "/bin/sh", "-c", command], {
      cwd,
      detached: process.platform !== "win32",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const killChild = () => {
      if (!child.killed) {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }
    };

    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killChild();
      }, options.timeout * 1000);
    }

    const onAbort = () => {
      if (settled) return;
      killChild();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.on("error", (err) => {
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      runCleanup();
      reject(err);
    });
    child.on("close", (code) => {
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      runCleanup();
      if (options.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${options.timeout}`));
        return;
      }
      resolve({ exitCode: code });
    });
  });
}

// ─── Provider factory ──────────────────────────────────────────────────────

const PROVIDERS: SandboxProvider[] = [new SandboxExecProvider(), new BubblewrapProvider()];
const NOOP = new NoopProvider();

export function selectProvider(): SandboxProvider {
  return PROVIDERS.find((p) => p.available()) ?? NOOP;
}
