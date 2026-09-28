import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildConfig, findNetworkSource, findTildeWarnings, getConfigPaths, mergeFileConfigs } from "./config.ts";
import { isPathWritable, resolveRealPath } from "./guard.ts";

describe("mergeFileConfigs", () => {
  it("concatenates deny arrays in priority order", () => {
    assert.deepEqual(mergeFileConfigs([{ deny: ["/a"] }, { deny: ["/b"] }]).deny, ["/a", "/b"]);
  });

  it("uses the strictest allowNetwork (any false wins)", () => {
    assert.equal(mergeFileConfigs([{ allowNetwork: false }, { allowNetwork: true }]).allowNetwork, false);
    assert.equal(mergeFileConfigs([{ allowNetwork: true }, { allowNetwork: false }]).allowNetwork, false);
    assert.equal(mergeFileConfigs([{ allowNetwork: true }, {}]).allowNetwork, true);
    assert.equal(mergeFileConfigs([{}, {}]).allowNetwork, undefined);
  });
});

describe("findNetworkSource", () => {
  it("reports the file that decided allowNetwork", () => {
    const files = [{}, { allowNetwork: true }, { allowNetwork: false }];
    assert.equal(findNetworkSource(["/p", "/a", "/h"], files, false), "/h");
    assert.equal(findNetworkSource(["/p", "/a", "/h"], files.slice(0, 2), true), "/a");
  });

  it("returns undefined when no file sets allowNetwork", () => {
    assert.equal(findNetworkSource(["/p"], [{}], undefined), undefined);
  });
});

describe("getConfigPaths", () => {
  it("lists the project config first", () => {
    assert.equal(getConfigPaths("/workspace")[0], "/workspace/.pi/sandbox.json");
  });
});

describe("buildConfig", () => {
  const empty = {};

  it("defaults allowNetwork to true", () => {
    assert.equal(buildConfig(empty, "/workspace").allowNetwork, true);
    assert.equal(buildConfig({ allowNetwork: false }, "/workspace").allowNetwork, false);
  });

  it("includes built-in writable roots (workspace, tmp, agent dir)", () => {
    const config = buildConfig(empty, "/workspace");
    assert.ok(config.writable.includes("/workspace"));
    assert.ok(config.writable.includes(resolveRealPath(getAgentDir())));
  });

  it("merges user deny with the default deny list", () => {
    const config = buildConfig({ deny: ["/extra"] }, "/workspace");
    assert.ok(config.deny.includes(resolveRealPath(`${homedir()}/.ssh`)));
    assert.ok(config.deny.includes("/extra"));
  });

  it("expands variables and keeps globs", () => {
    const config = buildConfig({ deny: ["${WORKSPACE}/**/.env*", "${HOME}/secret"] }, "/workspace");
    assert.ok(config.deny.includes("/workspace/**/.env*"));
    assert.ok(config.deny.includes(resolveRealPath(`${homedir()}/secret`)));
  });

  it("treats ~ literally (workspace-relative)", () => {
    const config = buildConfig({ deny: ["~/secret"] }, "/workspace");
    assert.ok(config.deny.includes("/workspace/~/secret"));
  });

  it("resolves relative entries against the workspace", () => {
    const config = buildConfig({ deny: ["secrets/*.key"] }, "/workspace");
    assert.ok(config.deny.includes("/workspace/secrets/*.key"));
  });

  it("always write-protects sandbox config files", () => {
    const config = buildConfig(empty, "/workspace");
    for (const p of getConfigPaths("/workspace")) {
      assert.equal(isPathWritable(resolveRealPath(p), config), false);
    }
  });
});

describe("findTildeWarnings", () => {
  it("warns on ~ entries only", () => {
    assert.equal(findTildeWarnings({ deny: ["~/a", "~", "/x/~/y", "~foo"] }).length, 2);
  });
});
