#!/usr/bin/env node
/**
 * scripts/check-version-sync.mjs
 * 
 * Kiểm tra rằng version trong package.json, Cargo.toml và tauri.conf.json
 * phải giống nhau. Chạy lệnh này trước khi build hoặc push để tránh lỗi
 * "bị bắt cập nhật mãi" do APP_VERSION không đồng bộ.
 * 
 * Usage: node scripts/check-version-sync.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Read package.json
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pkgVersion = pkg.version;

// Read tauri.conf.json
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tauriVersion = tauriConf.version;

// Read Cargo.toml (simple regex, no TOML parser needed)
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoMatch = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
const cargoVersion = cargoMatch?.[1];

let ok = true;

if (pkgVersion !== tauriVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != tauri.conf.json (${tauriVersion})`);
  ok = false;
}

if (pkgVersion !== cargoVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != Cargo.toml (${cargoVersion})`);
  ok = false;
}

if (ok) {
  console.log(`✅ Version sync OK: all files at v${pkgVersion}`);
  console.log("   Note: APP_VERSION in types.ts is auto-injected by Vite — no manual sync needed.");
} else {
  console.error("");
  console.error("Fix: run the version bump script to sync all files:");
  console.error("  node scripts/bump-version.mjs <new-version>");
  process.exit(1);
}
