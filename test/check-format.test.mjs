import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkText, checkRepository } from "../scripts/check-format.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synthetic-format-"));
  for (const name of ["src", "test", "scripts", "contract", "docs", ".github/workflows"]) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: synthetic\n");
  return root;
}
test("hygiene validates UTF8 and JSON without imposing a formatting style", () => {
  assert.deepEqual(checkText("sample.json", Buffer.from('{"value":1}\r\n')), []);
  assert.deepEqual(checkText("sample.ts", Buffer.from("const value=1;\n")), []);
  assert.deepEqual(checkText("sample.md", Buffer.from(" ".repeat(1024 * 1024) + "x\n")), []);
  assert.deepEqual(checkText("sample.ts", Buffer.from([0xc3, 0x28])), ["INVALID_UTF8"]);
  assert.deepEqual(checkText("sample.json", Buffer.from("{invalid}\n")), ["INVALID_JSON"]);
  assert.deepEqual(checkText("sample.ts", Buffer.from("value \n")), ["TRAILING_WHITESPACE"]);
  assert.deepEqual(checkText("sample.ts", Buffer.from("value")), ["FINAL_NEWLINE"]);
  assert.deepEqual(checkText("sample.ts", Buffer.from("value\n\n")), ["FINAL_NEWLINE"]);
  assert.ok(checkText("sample.ts", Buffer.from("value\rnext\n")).includes("BARE_CR"));
});
test("hygiene finds added targets, skips configurations and never rewrites files", () => {
  const root = fixture();
  writeFileSync(join(root, ".env"), Buffer.from([0xff]));
  writeFileSync(join(root, ".prettierrc.json"), "invalid");
  mkdirSync(join(root, "src/.private"));
  writeFileSync(join(root, "src/.private/config.json"), "invalid");
  const path = join(root, "src/added.json");
  const original = Buffer.from('{"value": 1} \n');
  writeFileSync(path, original);
  const result = checkRepository(root);
  assert.equal(result.filesChecked, 3);
  assert.deepEqual(result.failures, [{ path: "src/added.json", errors: ["TRAILING_WHITESPACE"] }]);
  assert.deepEqual(readFileSync(path), original);
});
test("hygiene refuses linked scan roots and linked workflow ancestors", () => {
  const root = fixture(), outside = fixture();
  renameSync(join(root, "src"), join(root, "src-original"));
  symlinkSync(join(outside, "src"), join(root, "src"), "junction");
  assert.throws(() => checkRepository(root), /LINK_TARGET/);
  const other = fixture();
  renameSync(join(other, ".github"), join(other, ".github-original"));
  symlinkSync(join(outside, ".github"), join(other, ".github"), "junction");
  assert.throws(() => checkRepository(other), /LINK_TARGET/);
});
test("hygiene refuses linked descendants and an aliased repository root", () => {
  const root = fixture(), outside = fixture();
  symlinkSync(join(outside, "src"), join(root, "src/escape"), "junction");
  assert.throws(() => checkRepository(root), /LINK_TARGET/);
  const alias = join(root, "alias");
  symlinkSync(outside, alias, "junction");
  assert.throws(() => checkRepository(alias), /LINK_ROOT/);
});
test("hygiene bounds file reads and rejects arbitrary CLI paths", () => {
  const root = fixture();
  writeFileSync(join(root, "src/oversized.json"), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  assert.throws(() => checkRepository(root), /FILE_TOO_LARGE/);
  const script = resolve(import.meta.dirname, "../scripts/check-format.mjs");
  const child = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot ?? "/", WINDIR: process.env.WINDIR ?? "/" } });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ARGUMENTS_FORBIDDEN/);
});
