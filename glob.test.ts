import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandGlob, globToRegexSource, isGlob, pathMatches, splitGlob } from "./glob.ts";

describe("glob", () => {
  it("detects globs", () => {
    assert.equal(isGlob("/a/b"), false);
    assert.equal(isGlob("/a/*.ts"), true);
    assert.equal(isGlob("/a/{b,c}"), true);
  });

  it("converts to regex", () => {
    assert.equal(globToRegexSource("/a/**/b"), "/a/(.*/)?b");
    assert.equal(globToRegexSource("/a/*.ts"), "/a/[^/]*\\.ts");
    assert.equal(globToRegexSource("/a/[!x]"), "/a/[^x]");
    assert.throws(() => globToRegexSource("/a/{b"));
  });

  it("matches paths and subtrees", () => {
    assert.equal(pathMatches("/a/b/c", "/a/b"), true);
    assert.equal(pathMatches("/a/bc", "/a/b"), false);
    assert.equal(pathMatches("/x", "/"), true);
    assert.equal(pathMatches("/a/x/y/.env/z", "/a/**/.env"), true);
    assert.equal(pathMatches("/a/.env", "/a/**/.env"), true);
    assert.equal(pathMatches("/a/b.env", "/a/**/.env"), false);
  });

  it("splits literal base from glob", () => {
    assert.deepEqual(splitGlob("/a/b/**/c"), { base: "/a/b", rest: "**/c" });
    assert.deepEqual(splitGlob("/*/c"), { base: "/", rest: "*/c" });
  });

  it("expands globs on the filesystem (including dotfiles, not following symlinked dirs for **)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-glob-"));
    try {
      mkdirSync(join(dir, "a", ".hid"), { recursive: true });
      writeFileSync(join(dir, ".env"), "");
      writeFileSync(join(dir, "a", ".hid", ".env"), "");
      writeFileSync(join(dir, "a", "x.txt"), "");
      symlinkSync(join(dir, "a"), join(dir, "link"));
      assert.deepEqual(expandGlob(`${dir}/**/.env`).sort(), [join(dir, ".env"), join(dir, "a", ".hid", ".env")].sort());
      assert.deepEqual(expandGlob(`${dir}/*/x.txt`).sort(), [join(dir, "a", "x.txt"), join(dir, "link", "x.txt")].sort());
      assert.deepEqual(expandGlob(`${dir}/nope/*`), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
