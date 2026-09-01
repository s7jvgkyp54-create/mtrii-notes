#!/usr/bin/env node
/**
 * Release form / hard gate.
 *
 * Run after `npm run desktop:build` and before creating a GitHub Release.
 * It blocks a release when the candidate version is duplicated, lower than
 * the newest remote tag, out of sync, or paired with the wrong installer.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const candidate = String(pkg.version ?? "").replace(/^v/i, "");
const repo = process.env.NOTES_RELEASE_REPO ?? "origin";
const installer = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Notes_${candidate}_x64-setup.exe`,
);

function parseVersion(value) {
  const match = String(value).trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version: ${!a ? left : right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function latestRemoteTag() {
  const output = execFileSync("git", ["ls-remote", "--tags", repo], {
    cwd: root,
    encoding: "utf8",
  });
  const tags = output
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1] ?? "")
    .map((ref) => ref.replace("refs/tags/", "").replace(/\^\{\}$/, ""))
    .filter((tag) => parseVersion(tag));
  return tags.sort((a, b) => compareVersions(b, a))[0] ?? null;
}

function checkVersionSync() {
  const check = spawnSync(process.execPath, ["scripts/check-version-sync.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  return { ok: check.status === 0, output: `${check.stdout}${check.stderr}`.trim() };
}

const rows = [];
const add = (label, ok, detail) => rows.push({ label, ok, detail });

const parsedCandidate = parseVersion(candidate);
add("Số phiên bản ứng viên", Boolean(parsedCandidate), parsedCandidate ? `v${candidate}` : "Phải theo dạng x.y.z");

const sync = checkVersionSync();
add("Đồng bộ trong mọi tệp", sync.ok, sync.ok ? "package, lockfile, Tauri, Cargo và APP_VERSION khớp nhau" : sync.output);

let latest = null;
try {
  latest = latestRemoteTag();
  add(
    "So với tag GitHub mới nhất",
    Boolean(latest && parsedCandidate && compareVersions(candidate, latest) > 0),
    latest
      ? `Ứng viên v${candidate}; bản mới nhất trên GitHub ${latest}`
      : "Không tìm thấy tag phát hành trên remote",
  );
} catch (error) {
  add("So với tag GitHub mới nhất", false, error instanceof Error ? error.message : String(error));
}

add("Installer đúng phiên bản", existsSync(installer), existsSync(installer) ? installer : `Thiếu ${installer}`);

console.log("\n╭─ FORM KIỂM TRA PHÁT HÀNH ─────────────────────────────────");
for (const row of rows) {
  console.log(`${row.ok ? "✅" : "❌"} ${row.label}: ${row.detail}`);
}
const allowed = rows.every((row) => row.ok);
console.log(`╰─ KẾT QUẢ: ${allowed ? "ĐƯỢC PHÉP UPLOAD" : "BỊ CHẶN — không tạo GitHub Release"}\n`);

if (!allowed) process.exit(1);
