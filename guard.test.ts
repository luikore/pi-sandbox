import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  expandHomePath,
  filterSearchOutput,
  findMatch,
  isPathReadable,
  isPathWritable,
  resolveToolPath,
  stripTrailingSep,
} from "./guard.ts";
import type { SandboxConfig } from "./types.ts";

const base: SandboxConfig = {
  deny: [],
  writable: ["/workspace", "/tmp"],
  denyWrite: ["/workspace/.git/hooks"],
  allowNetwork: true,
};

describe("stripTrailingSep", () => {
  it("strips trailing slashes but preserves root", () => {
    assert.equal(stripTrailingSep("/foo/bar///"), "/foo/bar");
    assert.equal(stripTrailingSep("///"), "/");
    assert.equal(stripTrailingSep(""), "");
  });
});

describe("expandHomePath / resolveToolPath", () => {
  it("expands tilde", () => {
    assert.equal(expandHomePath("~"), homedir());
    assert.equal(resolveToolPath("/workspace", "~/file.txt"), `${homedir()}/file.txt`);
  });

  it("resolves relative paths against cwd", () => {
    assert.equal(resolveToolPath("/workspace", "src/file.txt"), "/workspace/src/file.txt");
  });
});

describe("isPathWritable", () => {
  it("allows writes within writable roots", () => {
    assert.equal(isPathWritable("/workspace/src/file.ts", base), true);
    assert.equal(isPathWritable("/workspace", base), true);
    assert.equal(isPathWritable("/tmp/build/output", base), true);
  });

  it("blocks writes outside writable roots and sibling prefixes", () => {
    assert.equal(isPathWritable("/etc/hosts", base), false);
    assert.equal(isPathWritable("/workspace-other", base), false);
    assert.equal(isPathWritable("/workspace/../etc/hosts", base), false);
  });

  it("blocks denyWrite paths", () => {
    assert.equal(isPathWritable("/workspace/.git/hooks/pre-commit", base), false);
  });

  it("deny wins over writable", () => {
    const c = { ...base, deny: ["/workspace/secret"] };
    assert.equal(isPathWritable("/workspace/secret/x", c), false);
  });
});

describe("isPathReadable", () => {
  it("allows everything not denied", () => {
    assert.equal(isPathReadable("/etc/hosts", base), true);
  });

  it("blocks literal deny and descendants", () => {
    const c = { ...base, deny: ["/home/u/.ssh"] };
    assert.equal(isPathReadable("/home/u/.ssh", c), false);
    assert.equal(isPathReadable("/home/u/.ssh/id_rsa", c), false);
    assert.equal(isPathReadable("/home/u/.sshx", c), true);
  });

  it("supports * and ** globs (including dotfiles)", () => {
    const c = { ...base, deny: ["/workspace/**/.env*", "/home/u/*.pem"] };
    assert.equal(isPathReadable("/workspace/.env", c), false);
    assert.equal(isPathReadable("/workspace/a/b/.env.local", c), false);
    assert.equal(isPathReadable("/workspace/env", c), true);
    assert.equal(isPathReadable("/home/u/k.pem", c), false);
    assert.equal(isPathReadable("/home/u/sub/k.pem", c), true);
  });

  it("supports ?, [] and {} globs", () => {
    const c = { ...base, deny: ["/w/id_?sa", "/w/[ab].txt", "/w/*.{key,p12}"] };
    assert.equal(isPathReadable("/w/id_rsa", c), false);
    assert.equal(isPathReadable("/w/a.txt", c), false);
    assert.equal(isPathReadable("/w/c.txt", c), true);
    assert.equal(isPathReadable("/w/x.p12", c), false);
    assert.equal(isPathReadable("/w/x.pem", c), true);
  });

  it("glob matching a directory denies its subtree", () => {
    const c = { ...base, deny: ["/home/*/.aws"] };
    assert.equal(isPathReadable("/home/u/.aws/credentials", c), false);
  });

  it("findMatch reports the matching entry", () => {
    assert.equal(findMatch("/w/a/.env", ["/x", "/w/**/.env"]), "/w/**/.env");
  });
});

describe("filterSearchOutput", () => {
  const c = { ...base, deny: ["/workspace/**/.env", "/workspace/secret"] };

  it("filters find output", () => {
    const { text, hidden } = filterSearchOutput("src/a.ts\n.env\nsecret/x\nb/.env", "/workspace", "find", c);
    assert.equal(text, "src/a.ts");
    assert.equal(hidden, 3);
  });

  it("filters grep output with and without context lines", () => {
    const out = ["src/a.ts:1: ok", ".env:2: TOKEN=x", "secret/k-3- ctx", "src/b-1.ts:4: ok"].join("\n");
    const { text, hidden } = filterSearchOutput(out, "/workspace", "grep", c);
    assert.equal(text, "src/a.ts:1: ok\nsrc/b-1.ts:4: ok");
    assert.equal(hidden, 2);
  });

  it("filters ls output", () => {
    const { text } = filterSearchOutput("src/\n.env\nsecret/", "/workspace", "ls", c);
    assert.equal(text, "src/");
  });
});
