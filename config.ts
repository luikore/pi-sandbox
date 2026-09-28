import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, SandboxFileConfig, PathResolver } from "./types.ts";
import { resolveRealPath } from "./guard.ts";
import { isGlob, splitGlob } from "./glob.ts";

const CONFIG_FILE = "sandbox.json";

/**
 * Config files in priority order (deduped when identical):
 * project `<workspace>/.pi/sandbox.json`, Pi agent dir (`$PI_CODING_AGENT_DIR`), then `~/.pi/agent`.
 */
export function getConfigPaths(workspaceDir: string): string[] {
  return [
    ...new Set([
      resolve(workspaceDir, ".pi", CONFIG_FILE),
      resolve(getAgentDir(), CONFIG_FILE),
      resolve(homedir(), ".pi/agent", CONFIG_FILE),
    ]),
  ];
}

export function createPathResolver(workspaceDir: string): PathResolver {
  const vars: Record<string, string> = {
    WORKSPACE: workspaceDir,
    HOME: homedir(),
    TMP: tmpdir(),
    TMPDIR: tmpdir(),
  };

  return {
    resolve(path: string): string {
      let resolved = path;
      for (const [key, value] of Object.entries(vars)) {
        resolved = resolved.replaceAll(`\${${key}}`, value);
      }
      return isAbsolute(resolved) ? resolved : resolve(workspaceDir, resolved);
    },
  };
}

const DEFAULT_DENY = [
  "${HOME}/.ssh",
  "${HOME}/.aws",
  "${HOME}/.gnupg",
  "${HOME}/.config/gcloud",
  "${HOME}/.netrc",
  "${HOME}/.git-credentials",
  "/etc/shadow",
  "/etc/sudoers",
];
const DEFAULT_WRITABLE = ["${WORKSPACE}", "${TMP}"];
const DEFAULT_DENY_WRITE = ["${WORKSPACE}/.git/hooks"];

/** Resolve variables and symlinks. For globs, only the literal directory prefix is realpath'd. */
function resolveEntry(entry: string, resolver: PathResolver): string {
  const p = resolver.resolve(entry);
  if (!isGlob(p)) return resolveRealPath(p);
  const { base, rest } = splitGlob(resolve(p));
  const realBase = resolveRealPath(base);
  return realBase === "/" ? `/${rest}` : `${realBase}/${rest}`;
}

function readFileConfig(path: string): SandboxFileConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !["deny", "allowNetwork"].includes(k));
  if (unknown.length > 0) throw new Error(`pi-sandbox: unknown field(s) in ${path}: ${unknown.join(", ")}`);
  const deny = raw.deny;
  if (deny !== undefined && !(Array.isArray(deny) && deny.every((x) => typeof x === "string"))) {
    throw new Error(`pi-sandbox: "deny" in ${path} must be an array of strings`);
  }
  if (raw.allowNetwork !== undefined && typeof raw.allowNetwork !== "boolean") {
    throw new Error(`pi-sandbox: "allowNetwork" in ${path} must be a boolean`);
  }
  return raw as SandboxFileConfig;
}

/** "~" is not expanded (it may be a real directory name); flag likely mistakes. */
export function findTildeWarnings(file: SandboxFileConfig): string[] {
  return (file.deny ?? [])
    .filter((p) => p === "~" || p.startsWith("~/"))
    .map((p) => `pi-sandbox: "${p}" is not expanded; it resolves relative to the workspace. Use \${HOME} for the home directory.`);
}

/** deny lists are concatenated; allowNetwork uses the strictest value (any false wins). */
export function mergeFileConfigs(configs: SandboxFileConfig[]): SandboxFileConfig {
  const values = configs.map((c) => c.allowNetwork).filter((v) => v !== undefined);
  return {
    deny: configs.flatMap((c) => c.deny ?? []),
    allowNetwork: values.length > 0 ? values.every(Boolean) : undefined,
  };
}

/** User deny entries are appended to the built-in defaults. */
export function buildConfig(file: SandboxFileConfig, workspaceDir: string): SandboxConfig {
  const resolver = createPathResolver(workspaceDir);
  const res = (list: string[]) => [...new Set(list.map((p) => resolveEntry(p, resolver)))];
  return {
    deny: res([...DEFAULT_DENY, ...(file.deny ?? [])]),
    writable: res([...DEFAULT_WRITABLE, getAgentDir()]),
    denyWrite: res([...DEFAULT_DENY_WRITE, ...getConfigPaths(workspaceDir)]),
    allowNetwork: file.allowNetwork ?? true,
  };
}

/** First file whose allowNetwork equals the merged value; undefined when no file sets it. */
export function findNetworkSource(
  sources: string[],
  files: SandboxFileConfig[],
  allowNetwork: boolean | undefined,
): string | undefined {
  if (allowNetwork === undefined) return undefined;
  return sources[files.findIndex((f) => f.allowNetwork === allowNetwork)];
}

export interface LoadedConfig {
  config: SandboxConfig;
  /** sandbox.json files that were found and read, in priority order. */
  sources: string[];
  /** File that decided allowNetwork, or undefined when the default (true) applies. */
  networkSource: string | undefined;
  warnings: string[];
}

export function loadConfig(workspaceDir: string): LoadedConfig {
  const sources = getConfigPaths(workspaceDir).filter((p) => existsSync(p));
  const files = sources.map(readFileConfig);
  const merged = mergeFileConfigs(files);
  return {
    config: buildConfig(merged, workspaceDir),
    sources,
    networkSource: findNetworkSource(sources, files, merged.allowNetwork),
    warnings: findTildeWarnings(merged),
  };
}
