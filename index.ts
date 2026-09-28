import {
  type ExtensionAPI,
  createBashTool,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { selectProvider } from "./providers.ts";
import { filterSearchOutput, findMatch, isPathWritable, resolveToolPath, resolveRealPath } from "./guard.ts";

let _version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
  _version = pkg.version ?? "unknown";
} catch (err) {
  if (err instanceof SyntaxError) {
    console.warn("[pi-sandbox] Failed to parse package.json — version reporting disabled");
  }
}

export function assertSandboxProviderAvailable(enabled: boolean, providerName: string): void {
  if (enabled && providerName === "none") {
    throw new Error("pi-sandbox: sandbox enabled but no supported OS sandbox provider is available");
  }
}

export function resolveStartupOverride(
  forceSandbox: boolean,
  forceNoSandbox: boolean,
): { runtimeEnabledOverride: boolean | undefined; warnings: string[] } {
  if (forceSandbox && forceNoSandbox) {
    return {
      runtimeEnabledOverride: false,
      warnings: ["[pi-sandbox] Both --sandbox and --no-sandbox were provided; --no-sandbox wins."],
    };
  }
  return { runtimeEnabledOverride: forceSandbox ? true : forceNoSandbox ? false : undefined, warnings: [] };
}

export default function (pi: ExtensionAPI) {
  const workspaceDir = process.cwd();
  let runtimeEnabledOverride: boolean | undefined;

  pi.registerFlag("sandbox", {
    description: "Enable pi-sandbox for this Pi process",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable pi-sandbox for this Pi process",
    type: "boolean",
    default: false,
  });

  function syncStartupOverrides() {
    const resolved = resolveStartupOverride(pi.getFlag("sandbox") === true, pi.getFlag("no-sandbox") === true);
    runtimeEnabledOverride = resolved.runtimeEnabledOverride;
    for (const warning of resolved.warnings) {
      console.warn(warning);
    }
  }

  function getState() {
    return { config: loadConfig(workspaceDir).config, activeProvider: selectProvider(), enabled: runtimeEnabledOverride ?? true };
  }

  // ── Bash tool override ──────────────────────────────────────────────────

  const localOps = createLocalBashOperations();
  const dynamicOps = {
    exec(command: string, cwd: string, options: Parameters<typeof localOps.exec>[2]) {
      const state = getState();
      if (!state.enabled) {
        return localOps.exec(command, cwd, options);
      }
      assertSandboxProviderAvailable(state.enabled, state.activeProvider.name);
      return state.activeProvider.wrap(localOps, workspaceDir, state.config).exec(command, cwd, options);
    },
  };

  const bashTool = createBashTool(workspaceDir, {
    operations: dynamicOps,
  });
  pi.registerTool(bashTool);

  // ── Path guard for in-process file tools (write, edit) ──────────────────

  pi.on("tool_call", async (event, ctx) => {
    const { config, enabled } = getState();
    if (!enabled) return;
    const cwd = ctx.cwd ?? workspaceDir;
    const abs = (p: string) => resolveRealPath(resolveToolPath(cwd, p));
    const input = event.input as Record<string, string | undefined>;

    // Write-like tools. delete/move are future-proof guards for tools Pi doesn't ship yet.
    const writeTargets: Record<string, [string, string | undefined][]> = {
      write: [["write", input.path]],
      edit: [["edit", input.path]],
      delete: [["delete", input.path ?? input.filePath]],
      move: [["move from", input.path ?? input.source], ["move to", input.destination ?? input.target]],
    };
    for (const [action, target] of Object.hasOwn(writeTargets, event.toolName) ? writeTargets[event.toolName] : []) {
      if (target && !isPathWritable(abs(target), config)) {
        return { block: true, reason: `pi-sandbox: ${action} of "${target}" blocked (outside writable paths, or matches deny)` };
      }
    }

    // Read-like tools. grep/find/ls results inside allowed roots are filtered in tool_result.
    if (["read", "grep", "find", "ls"].includes(event.toolName)) {
      const target = input.path ?? ".";
      const denied = findMatch(abs(target), config.deny);
      if (denied) {
        return { block: true, reason: `pi-sandbox: ${event.toolName} of "${target}" blocked (matches deny: ${denied})` };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const tool = event.toolName;
    if (tool !== "grep" && tool !== "find" && tool !== "ls") return;
    const { config, enabled } = getState();
    if (!enabled || event.isError) return;
    const root = resolveRealPath(resolveToolPath(ctx.cwd ?? workspaceDir, (event.input.path as string | undefined) ?? "."));
    let hiddenTotal = 0;
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const { text, hidden } = filterSearchOutput(c.text, root, tool, config);
      hiddenTotal += hidden;
      return { ...c, text };
    });
    if (hiddenTotal === 0) return;
    content.push({ type: "text", text: `[pi-sandbox: ${hiddenTotal} result(s) hidden (denied paths)]` });
    return { content };
  });

  pi.on("session_start", async (_event, ctx) => {
    syncStartupOverrides();
    const { config, sources, networkSource, warnings } = loadConfig(workspaceDir);
    ctx.ui.notify(
      [
        `pi-sandbox: ${sources.length > 0 ? `loaded ${sources.join(", ")}` : "no sandbox.json found, using defaults"}`,
        `pi-sandbox: network ${config.allowNetwork ? "allowed" : "blocked"} (${networkSource ?? "default"})`,
      ].join("\n"),
      "info",
    );
    for (const w of warnings) ctx.ui.notify(w, "warning");
  });

  // User-typed `!`/`!!` commands are never sandboxed: no user_bash handler, so Pi
  // runs them with its normal local shell backend.

  // ── Command: show sandbox status ────────────────────────────────────────

  pi.registerCommand("sandbox-status", {
    description: "Show pi-sandbox status and configuration",
    handler: async (_args, ctx) => {
      const { config, activeProvider, enabled } = getState();
      const list = (items: string[]) => (items.length > 0 ? items.map((p) => `  - ${p}`) : ["  - none"]);
      const lines = [
        `pi-sandbox v${_version}`,
        `Enabled:      ${enabled ? "yes" : "no"}`,
        `Override:     ${runtimeEnabledOverride === undefined ? "default" : runtimeEnabledOverride ? "enabled" : "disabled"}`,
        `Provider:     ${activeProvider.name}${enabled && activeProvider.name === "none" ? " (unavailable)" : ""}`,
        `Network:      ${config.allowNetwork ? "allowed" : "blocked"}`,
        `Config:       ${loadConfig(workspaceDir).sources.join(", ") || "none (defaults)"}`,
        "Writable (built-in):",
        ...list(config.writable),
        "Deny (read+write):",
        ...list(config.deny),
        "Deny (write, built-in):",
        ...list(config.denyWrite),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable pi-sandbox for the current Pi process",
    handler: async (_args, ctx) => {
      const { activeProvider } = getState();
      if (activeProvider.name === "none") {
        ctx.ui.notify("pi-sandbox: no sandbox provider available on this system", "error");
        return;
      }
      runtimeEnabledOverride = true;
      ctx.ui.notify("pi-sandbox enabled for this Pi process", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable pi-sandbox for the current Pi process",
    handler: async (_args, ctx) => {
      runtimeEnabledOverride = false;
      ctx.ui.notify("pi-sandbox disabled for this Pi process", "warning");
    },
  });

  pi.registerCommand("sandbox-reset", {
    description: "Reset pi-sandbox runtime override and return to config-driven mode",
    handler: async (_args, ctx) => {
      runtimeEnabledOverride = undefined;
      syncStartupOverrides();
      ctx.ui.notify("pi-sandbox overrides cleared; using config again", "info");
    },
  });
}
