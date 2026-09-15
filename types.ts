import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface SandboxConfig {
  /** Global sandbox switch. When false, bash and file-tool guards run unsandboxed. Default: true. */
  enabled: boolean;
  /** When true, block all filesystem writes regardless of writable roots. */
  readOnly?: boolean;
  /** Paths explicitly allowed for reads, overriding defaultDenyRead entries. */
  allowRead?: string[];
  /** Paths explicitly denied for reads by built-in read-only file tools. */
  denyRead: string[];
  /** Directories the agent is allowed to write to. "${WORKSPACE}" expands to the project root. */
  writable: string[];
  /** Paths explicitly denied for writes, even inside writable directories (e.g. .git/hooks). */
  denyWithin: string[];
  /** Allow outbound network access. Default: true. */
  network: boolean;
  /** Force a specific provider: "auto" | "sandbox-exec" | "bubblewrap" | "none". Default: "auto". */
  provider?: SandboxProviderType;
  /**
   * When true, user-typed `!`/`!!` shell commands are run inside the sandbox
   * like the agent's bash tool. When false (default), user commands run with
   * Pi's normal local shell backend and are not sandboxed, because they are
   * explicitly issued by the human rather than the model.
   */
  sandboxUserShell?: boolean;
}

export type SandboxProviderType = "auto" | "sandbox-exec" | "bubblewrap" | "none";

export interface SandboxProvider {
  /** Human-readable name for logging. */
  readonly name: string;
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
