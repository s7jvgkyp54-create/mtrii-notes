#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-desktop");
const html = readFileSync(join(dist, "index.html"), "utf8");
const match = html.match(/<script\b[^>]*\bsrc="\.\/([^"]+\.js)"[^>]*><\/script>/i);
const budgetBytes = Number(process.env.DESKTOP_ENTRY_BUDGET_BYTES || 350 * 1024);
const regressionBaselineBytes = Number(
  process.env.DESKTOP_ENTRY_BASELINE_BYTES || 321_045,
);
const regressionLimitBytes = Math.round(regressionBaselineBytes * 1.1);

if (!match) {
  console.error(JSON.stringify({ ok: false, error: "desktop module entry was not found" }, null, 2));
  process.exit(1);
}

const entryPath = join(dist, match[1]);
const bytes = statSync(entryPath).size;
const result = {
  ok: bytes <= budgetBytes && bytes <= regressionLimitBytes,
  entry: relative(root, entryPath),
  bytes,
  budgetBytes,
  regressionBaselineBytes,
  regressionLimitBytes,
  regressionPercent: Math.round(((bytes - regressionBaselineBytes) / regressionBaselineBytes) * 1_000) / 10,
  savedFromBaselineBytes: 542_380 - bytes,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
