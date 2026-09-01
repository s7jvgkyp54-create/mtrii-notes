#!/usr/bin/env node
/**
 * scripts/bump-version.mjs
 *
 * Bump version đồng bộ trong:
 *   - package.json
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *
 * APP_VERSION trong types.ts KHÔNG cần sửa thủ công — Vite tự inject từ package.json.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch   # 0.5.9 → 0.5.10
 *   node scripts/bump-version.mjs minor   # 0.5.9 → 0.6.0
 *   node scripts/bump-version.mjs major   # 0.5.9 → 1.0.0
 *   node scripts/bump-version.mjs 0.6.0   # set cụ thể
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2] ?? "patch";

// Bump package.json via npm
execSync(`npm version ${arg} --no-git-tag-version`, { cwd: root, stdio: "inherit" });

// Re-read new version
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const newVersion = pkg.version;

// Sync tauri.conf.json
const tauriConfPath = join(root, "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
tauriConf.version = newVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

// Sync Cargo.toml (replace version = "..." under [package])
const cargoPath = join(root, "src-tauri", "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
cargo = cargo.replace(/^(\s*version\s*=\s*)"[^"]+"(\s*(?:#.*)?$)/m, `$1"${newVersion}"$2`);
writeFileSync(cargoPath, cargo);

console.log(`\n✅ Bumped all files to v${newVersion}`);
console.log("   - package.json");
console.log("   - src-tauri/tauri.conf.json");
console.log("   - src-tauri/Cargo.toml");
console.log("   (APP_VERSION in types.ts is auto-injected by Vite — no change needed)\n");
