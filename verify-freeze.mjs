#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(root, "FREEZE.sha256");

if (!existsSync(manifestPath)) {
  console.error(`missing manifest: ${manifestPath}`);
  process.exit(1);
}

const lines = readFileSync(manifestPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

let ok = 0;
const problems = [];

for (const line of lines) {
  const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
  if (!match) {
    problems.push(`malformed line: ${line}`);
    continue;
  }
  const [, expected, rel] = match;
  const abs = resolve(root, rel);
  if (!abs.startsWith(root)) {
    problems.push(`path escapes root: ${rel}`);
    continue;
  }
  if (!existsSync(abs)) {
    problems.push(`missing: ${rel}`);
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
  if (actual !== expected) {
    problems.push(`modified: ${rel}\n  expected ${expected}\n  actual   ${actual}`);
    continue;
  }
  ok += 1;
}

if (problems.length > 0) {
  console.error(`freeze check failed: ${ok}/${lines.length} ok`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`freeze check passed: ${ok}/${lines.length} files match FREEZE.sha256`);
