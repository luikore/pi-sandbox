import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Shape of sandbox.json. */
export interface SandboxFileConfig {
  /** Paths/globs the agent can neither read nor write. Merged with the built-in default deny list. */
  deny?: string[];
  /** Allow outbound network access. Default: true. */
  allowNetwork?: boolean;
}

/** Resolved runtime config. All paths are absolute (literal paths or globs). */
export interface SandboxConfig {
  deny: string[];
  /** Built-in writable roots: workspace, tmp, Pi agent dir. */
  writable: string[];
  /** Internal write-protected paths (.git/hooks, sandbox.json files). */
  denyWrite: string[];
  allowNetwork: boolean;
}

export type SandboxProviderType = "sandbox-exec" | "bubblewrap" | "none";

export interface SandboxProvider {
  /** Human-readable name for logging. */
  readonly name: SandboxProviderType;
  /** Whether this provider is available on the current system. */
  available(): boolean;
  /**
   * Wraps a BashOperations instance with sandbox enforcement.
   * Returns a new BashOperations whose `exec` passes commands through the OS sandbox.
   */
  wrap(inner: BashOperations, cwd: string, config: SandboxConfig): BashOperations;
}

export interface PathResolver {
  /** Resolve config path placeholders like "${WORKSPACE}" to real filesystem paths. */
  resolve(path: string): string;
}
