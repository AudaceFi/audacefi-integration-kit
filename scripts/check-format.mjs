import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const directories = ["src", "test", "scripts", "contract", "docs"];
const extensions = new Set([".ts", ".mts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
const maxBytes = 2 * 1024 * 1024;

// This is text hygiene and JSON syntax validation, not a code formatter.
export function checkText(name, bytes) {
  const errors = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return ["UTF8_BOM"];
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return ["INVALID_UTF8"]; }
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) errors.push("BARE_CR");
  if (normalized.split("\n").some((line) => line.endsWith(" ") || line.endsWith("\t"))) errors.push("TRAILING_WHITESPACE");
  if (normalized && (!normalized.endsWith("\n") || normalized.endsWith("\n\n"))) errors.push("FINAL_NEWLINE");
  if (extname(name) === ".json") {
    try { JSON.parse(normalized); } catch { errors.push("INVALID_JSON"); }
  }
  return errors;
}

export function checkRepository(root) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink()) throw new Error("LINK_ROOT");
  const actualRoot = realpathSync(root);
  const targets = [];
  function inspect(name) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("LINK_TARGET: " + name);
    const inside = relative(actualRoot, realpathSync(path));
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep) || resolve(actualRoot, inside) !== realpathSync(path)) throw new Error("OUTSIDE_ROOT: " + name);
    return info;
  }
  function add(name) {
    const info = inspect(name);
    if (!info.isFile()) throw new Error("NOT_REGULAR_FILE: " + name);
    if (info.size > maxBytes) throw new Error("FILE_TOO_LARGE: " + name);
    targets.push(name);
    if (targets.length > 1000) throw new Error("TOO_MANY_FILES");
  }
  function walk(name, depth = 0) {
    if (depth > 12) throw new Error("DIRECTORY_TOO_DEEP");
    if (!inspect(name).isDirectory()) throw new Error("NOT_DIRECTORY: " + name);
    for (const entry of readdirSync(join(root, name)).sort()) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
      const child = join(name, entry);
      const info = inspect(child);
      if (info.isDirectory()) walk(child, depth + 1);
      else if (extensions.has(extname(entry))) add(child);
    }
  }
  for (const name of directories) walk(name);
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    if (name.endsWith(".md") || name === "package.json" || /^tsconfig.*\.json$/.test(name)) add(name);
  }
  if (!inspect(".github").isDirectory() || !inspect(".github/workflows").isDirectory()) throw new Error("NOT_DIRECTORY: workflow ancestors");
  add(".github/workflows/ci.yml");
  const failures = [];
  for (const name of targets.sort()) {
    // Recheck links and size immediately before reading; not an adversarial race sandbox.
    const info = inspect(name);
    if (!info.isFile() || info.size > maxBytes) throw new Error("CHANGED_TARGET: " + name);
    const errors = checkText(name, readFileSync(join(root, name)));
    if (errors.length) failures.push({ path: name.split(sep).join("/"), errors });
  }
  return { filesChecked: targets.length, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("ARGUMENTS_FORBIDDEN");
  const result = checkRepository(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (result.failures.length) {
    for (const failure of result.failures) console.error(failure.path + ": " + failure.errors.join(", "));
    process.exitCode = 1;
  } else console.log("Text hygiene and JSON syntax: " + result.filesChecked + " files checked. No style normalization.");
}
