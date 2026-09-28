import { realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "./types.ts";
import { pathMatches } from "./glob.ts";

export function resolveRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    try {
      const parent = realpathSync(dirname(targetPath));
      return join(parent, basename(targetPath));
    } catch {
      return resolve(targetPath);
    }
  }
}

export function stripTrailingSep(p: string): string {
  while (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
}

export function expandHomePath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

export function resolveToolPath(cwd: string, targetPath: string): string {
  return resolve(cwd, expandHomePath(targetPath));
}

/** First entry (literal path or glob) that equals or contains absolutePath. */
export function findMatch(absolutePath: string, entries: string[]): string | undefined {
  const p = resolve(absolutePath);
  return entries.find((e) => pathMatches(p, e));
}

export function isPathReadable(absolutePath: string, config: SandboxConfig): boolean {
  return findMatch(absolutePath, config.deny) === undefined;
}

export function isPathWritable(absolutePath: string, config: SandboxConfig): boolean {
  if (findMatch(absolutePath, config.deny) || findMatch(absolutePath, config.denyWrite)) return false;
  return findMatch(absolutePath, config.writable) !== undefined;
}

/** Candidate file paths in a grep output line (`path:12: text` or `path-12- text`). */
function grepLinePaths(line: string): string[] {
  return [...line.matchAll(/[:-]\d+[:-] /g)].map((m) => line.slice(0, m.index));
}

/**
 * Drop grep/find/ls output lines that reference denied paths. Lines are paths relative to `root`.
 * Returns the filtered text and the number of hidden lines.
 */
export function filterSearchOutput(
  text: string,
  root: string,
  tool: "grep" | "find" | "ls",
  config: SandboxConfig,
): { text: string; hidden: number } {
  let hidden = 0;
  const kept = text.split("\n").filter((line) => {
    if (!line) return true;
    const candidates = tool === "grep" ? grepLinePaths(line) : [line];
    const denied = candidates.some((c) => !isPathReadable(resolve(root, c), config));
    if (denied) hidden++;
    return !denied;
  });
  return { text: kept.join("\n"), hidden };
}
