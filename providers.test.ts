import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapSetup, buildSandboxExecProfile } from "./providers.ts";
import type { SandboxConfig } from "./types.ts";

const cfg = (c: Partial<SandboxConfig>): SandboxConfig => ({
  deny: [],
  writable: [],
  denyWrite: [],
  allowNetwork: true,
  ...c,
});

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mountIndex(args: string[], flag: string, target: string): number {
  return args.findIndex((_a, i) => args[i] === flag && args[i + 2] === target);
}

describe("buildSandboxExecProfile", () => {
  it("emits deny rules for literal paths after writable rules", () => {
    const profile = buildSandboxExecProfile(cfg({ writable: ["/workspace"], deny: ["/workspace/secret"] }));
    const allowIdx = profile.indexOf('(allow file-write* (subpath "/workspace"))');
    const denyIdx = profile.indexOf('(deny file-read* file-write* (subpath "/workspace/secret"))');
    assert.notEqual(allowIdx, -1);
    assert.ok(denyIdx > allowIdx, "deny must come after writable so it wins");
  });

  it("emits regex rules for globs", () => {
    const profile = buildSandboxExecProfile(cfg({ deny: ["/w/**/.env*"] }));
    assert.ok(profile.includes('(deny file-read* file-write* (regex #"^/w/(.*/)?\\.env[^/]*(/.*)?$"))'), profile);
  });

  it("emits denyWrite rules", () => {
    const profile = buildSandboxExecProfile(cfg({ denyWrite: ["/w/.git/hooks"] }));
    assert.match(profile, /\(deny file-write\* \(subpath "\/w\/\.git\/hooks"\)\)/);
  });

  it("toggles network", () => {
    assert.match(buildSandboxExecProfile(cfg({})), /\(allow network\*\)/);
    assert.doesNotMatch(buildSandboxExecProfile(cfg({ allowNetwork: false })), /\(allow network\*\)/);
  });
});

describe("buildBwrapSetup", () => {
  it("overlays denied files and directories after normal binds", () => {
    withTmp((ws) => {
      const secretFile = join(ws, "secret.txt");
      const secretDir = join(ws, "secretdir");
      writeFileSync(secretFile, "secret");
      mkdirSync(secretDir);
      const setup = buildBwrapSetup(ws, cfg({ writable: [ws], deny: [secretFile, secretDir] }), ws);
      try {
        const bindIdx = mountIndex(setup.args, "--bind", ws);
        const fileIdx = mountIndex(setup.args, "--ro-bind", secretFile);
        const dirIdx = mountIndex(setup.args, "--ro-bind", secretDir);
        assert.ok(bindIdx >= 0 && fileIdx > bindIdx && dirIdx > bindIdx);
        assert.equal(statSync(setup.args[fileIdx + 1]).mode & 0o777, 0);
        assert.throws(() => readFileSync(setup.args[fileIdx + 1], "utf8"));
        assert.throws(() => readdirSync(setup.args[dirIdx + 1]));
      } finally {
        setup.cleanup();
      }
    });
  });

  it("expands deny globs against the filesystem", () => {
    withTmp((ws) => {
      mkdirSync(join(ws, "a", "b"), { recursive: true });
      writeFileSync(join(ws, ".env"), "x");
      writeFileSync(join(ws, "a", "b", ".env.local"), "x");
      writeFileSync(join(ws, "a", "keep.txt"), "x");
      const setup = buildBwrapSetup(ws, cfg({ writable: [ws], deny: [`${ws}/**/.env*`] }), ws);
      try {
        assert.notEqual(mountIndex(setup.args, "--ro-bind", join(ws, ".env")), -1);
        assert.notEqual(mountIndex(setup.args, "--ro-bind", join(ws, "a", "b", ".env.local")), -1);
        assert.equal(mountIndex(setup.args, "--ro-bind", join(ws, "a", "keep.txt")), -1);
      } finally {
        setup.cleanup();
      }
    });
  });

  it("toggles network", () => {
    withTmp((ws) => {
      assert.ok(buildBwrapSetup(ws, cfg({}), ws).args.includes("--share-net"));
      assert.ok(!buildBwrapSetup(ws, cfg({ allowNetwork: false }), ws).args.includes("--share-net"));
    });
  });
});
