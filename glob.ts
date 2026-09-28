import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Supported syntax: `*`, `**`, `?`, `[abc]`/`[!abc]`, `{a,b}` (within one path segment). Dotfiles always match. */
export function isGlob(p: string): boolean {
  return /[*?[{]/.test(p);
}

/** Unanchored regex source. Uses only POSIX ERE constructs so it also works in sandbox-exec SBPL `(regex ...)`. */
export function globToRegexSource(glob: string): string {
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const segStart = i === 0 || glob[i - 1] === "/";
        if (segStart && glob[i + 2] === "/") {
          out += "(.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[" && glob.indexOf("]", i + 2) > 0) {
      const end = glob.indexOf("]", i + 2);
      const body = glob.slice(i + 1, end);
      out += `[${body.startsWith("!") ? "^" + body.slice(1) : body}]`;
      i = end;
    } else if (c === "{") {
      out += "(";
      braces++;
    } else if (c === "}" && braces > 0) {
      out += ")";
      braces--;
    } else if (c === "," && braces > 0) {
      out += "|";
    } else {
      out += /[.+^$()|\\[\]{}]/.test(c) ? "\\" + c : c;
    }
  }
  if (braces > 0) throw new Error(`pi-sandbox: unbalanced "{" in glob "${glob}"`);
  return out;
}

/** Regex matching the pattern itself and anything beneath a matched path. */
export function globToSubtreeRegexSource(glob: string): string {
  return `^${globToRegexSource(glob)}(/.*)?$`;
}

const regexCache = new Map<string, RegExp>();

/** True if absolutePath equals or is inside `entry` (a literal absolute path or absolute glob). */
export function pathMatches(absolutePath: string, entry: string): boolean {
  if (isGlob(entry)) {
    let re = regexCache.get(entry);
    if (!re) {
      re = new RegExp(globToSubtreeRegexSource(entry));
      regexCache.set(entry, re);
    }
    return re.test(absolutePath);
  }
  const e = entry.length > 1 ? entry.replace(/\/+$/, "") : entry;
  return absolutePath === e || absolutePath.startsWith(e === "/" ? "/" : e + "/");
}

/** Split an absolute glob into its literal directory prefix and the glob remainder. */
export function splitGlob(pattern: string): { base: string; rest: string } {
  const segs = pattern.split("/");
  const i = segs.findIndex(isGlob);
  if (i < 0) return { base: pattern, rest: "" };
  return { base: segs.slice(0, i).join("/") || "/", rest: segs.slice(i).join("/") };
}

/** Expand an absolute glob to existing filesystem paths. Symlinked dirs are not traversed by `**`. */
export function expandGlob(pattern: string): string[] {
  if (!isGlob(pattern)) return [pattern];
  const { base, rest } = splitGlob(pattern);
  const out = new Set<string>();

  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") return [];
      throw err;
    }
  };

  const walk = (dir: string, segs: string[]) => {
    if (segs.length === 0) {
      out.add(dir);
      return;
    }
    const [seg, ...tail] = segs;
    if (seg === "**") {
      walk(dir, tail);
      for (const e of list(dir)) {
        if (e.isDirectory()) walk(join(dir, e.name), segs);
      }
      return;
    }
    const re = new RegExp(`^${globToRegexSource(seg)}$`);
    for (const e of list(dir)) {
      if (!re.test(e.name)) continue;
      const p = join(dir, e.name);
      if (tail.length === 0) out.add(p);
      else if (e.isDirectory() || e.isSymbolicLink()) walk(p, tail);
    }
  };

  walk(base, rest.split("/").filter(Boolean));
  return [...out];
}
