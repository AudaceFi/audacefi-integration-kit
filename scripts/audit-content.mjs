import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
const patterns = [
  /afk_[a-z0-9]{12}_[a-z0-9]{16}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\//i,
  /[.]up[.]railway[.]app|[.]supabase[.]co/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];
let errors = 0;
for (const file of [...new Set(files)]) {
  if (/(^|\/)([.]env([.]|$)|[.]dev[.]vars)/.test(file)) {
    console.error("Forbidden configuration file: " + file);
    errors++;
    continue;
  }
  const text = readFileSync(file, "utf8");
  if (patterns.some((p) => p.test(text))) {
    console.error("Sensitive-content candidate: " + file);
    errors++;
  }
  if (/[\u2014]/.test(text)) {
    console.error("Public-ready typography rule: " + file);
    errors++;
  }
}
if (errors) process.exit(1);
console.log(
  "Tracked and untracked non-ignored content: " +
    new Set(files).size +
    " files checked; no candidate matched. This is not a complete security audit.",
);
