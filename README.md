# @nqbao/pi-sandbox

OS-level sandbox extension for Pi.

This package overrides Pi's bash tool and applies an OS sandbox:
- macOS: `sandbox-exec`
- Linux: `bubblewrap`

It also blocks in-process file mutations outside the workspace, tmp and the Pi agent dir.

## Install

Install from npm through Pi:

```bash
pi install npm:@nqbao/pi-sandbox
```

Or load it locally during development:

```bash
pi -e ./index.ts
```

## What It Does

`pi-sandbox` adds two layers of protection:

- It overrides Pi's `bash` tool and runs shell commands inside an OS sandbox.
- It intercepts file tools and blocks writes outside the writable roots and reads/writes of `deny` paths for `read`, `write`, `edit`, `grep`, `find`, and `ls`.

Behavior depends on the platform:

- macOS: uses `sandbox-exec`
- Linux: uses `bubblewrap`
- if no supported provider is available and sandboxing is enabled: bash commands fail with an error rather than running unsandboxed

## Configuration

The extension reads and merges `sandbox.json` from (the files actually read are logged at startup):

1. Project: `${WORKSPACE}/.pi/sandbox.json` (highest priority)
2. Pi agent dir: `$PI_CODING_AGENT_DIR/sandbox.json`
3. `~/.pi/agent/sandbox.json`

> **Note:** `PI_CODING_AGENT_DIR` is an environment variable read by Pi itself (not by this extension).
> It overrides Pi's global config directory, which defaults to `~/.pi/agent`. When it is unset, both
> agent-dir entries above point to the same file, which is read once. See Pi's
> [environment variables docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md).

Fields (all optional, unknown fields are an error):

- `deny`: paths/globs that can be neither read nor written. Merged with the built-in default deny list.
- `allowNetwork`: allow outbound network access (default: `true`).

Merge: `deny` lists from the built-in defaults and all files are concatenated; `allowNetwork` uses the strictest
value — if any file sets `false`, network is blocked. The file that decided it is logged at startup.

A project `.pi/sandbox.json` can therefore only tighten the sandbox, never loosen it.

```json
{
  "deny": ["${HOME}/.config/my-secrets", "${WORKSPACE}/**/.env*", "${HOME}/**/*.pem"],
  "allowNetwork": true
}
```

Paths support `${WORKSPACE}`, `${HOME}`, `${TMP}`/`${TMPDIR}`; relative paths resolve against the workspace.
`~` is **not** expanded (it can be a real directory name); entries starting with `~/` log a warning at startup.
An entry matches the path itself and everything beneath it.

Glob syntax: `*` (within a segment), `**` (any depth), `?`, `[abc]`/`[!abc]`, `{a,b}`. Dotfiles are matched.
On Linux (bubblewrap), globs are expanded against the filesystem when each command starts, so files created
later in the same command are not covered. On macOS, globs compile to `sandbox-exec` regex rules.

Built-in defaults (always applied):

- writable: `${WORKSPACE}`, `${TMP}`, Pi agent dir (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`)
- deny: `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.gnupg`, `${HOME}/.config/gcloud`, `${HOME}/.netrc`, `${HOME}/.git-credentials`, `/etc/shadow`, `/etc/sudoers`
- write-protected: `${WORKSPACE}/.git/hooks`, all `sandbox.json` files above

For `read`/`grep`/`find`/`ls`, a denied target path is blocked; results inside denied paths are removed from
`grep`/`find`/`ls` output.

## Status Command

The extension registers a Pi command:

```text
/sandbox-status
```

It shows the loaded config files, active provider, network mode, writable roots and deny rules.

Runtime controls:

```text
/sandbox-enable
/sandbox-disable
/sandbox-reset
```

### User-typed `!` commands

Commands you type yourself with `!`/`!!` always run through Pi's normal local shell
backend and are **never** sandboxed — they are explicitly initiated by you, not the model.

Startup flags:

```bash
pi -e ./index.ts --sandbox
pi -e ./index.ts --no-sandbox
```

## Package

This is a Pi package and exposes its extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
