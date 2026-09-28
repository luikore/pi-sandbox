import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSandboxProviderAvailable, resolveStartupOverride } from "./index.ts";

describe("assertSandboxProviderAvailable", () => {
  it("allows disabled sandbox with no provider", () => {
    assert.doesNotThrow(() => assertSandboxProviderAvailable(false, "none"));
  });

  it("allows enabled sandbox when a provider exists", () => {
    assert.doesNotThrow(() => assertSandboxProviderAvailable(true, "sandbox-exec"));
  });

  it("fails enabled sandbox when no provider exists", () => {
    assert.throws(
      () => assertSandboxProviderAvailable(true, "none"),
      /sandbox enabled but no supported OS sandbox provider is available/,
    );
  });
});

describe("resolveStartupOverride", () => {
  it("returns undefined when no flags are set", () => {
    assert.deepEqual(resolveStartupOverride(false, false), { runtimeEnabledOverride: undefined, warnings: [] });
  });

  it("maps --sandbox and --no-sandbox", () => {
    assert.equal(resolveStartupOverride(true, false).runtimeEnabledOverride, true);
    assert.equal(resolveStartupOverride(false, true).runtimeEnabledOverride, false);
  });

  it("lets --no-sandbox win over --sandbox", () => {
    assert.deepEqual(resolveStartupOverride(true, true), {
      runtimeEnabledOverride: false,
      warnings: ["[pi-sandbox] Both --sandbox and --no-sandbox were provided; --no-sandbox wins."],
    });
  });
});
