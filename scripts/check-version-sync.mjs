#!/usr/bin/env node
/**
 * scripts/check-version-sync.mjs
 * 
 * Kiểm tra rằng các nơi đóng gói và hiển thị version đều dùng cùng một số.
 * Chạy lệnh này trước khi build hoặc push để tránh lỗi
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

const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const packageLockVersion = packageLock.version;

// Read tauri.conf.json
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tauriVersion = tauriConf.version;

// Read Cargo.toml (simple regex, no TOML parser needed)
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoMatch = cargoToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
const cargoVersion = cargoMatch?.[1];

const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
const cargoPackage = cargoLock
  .split("[[package]]")
  .find((entry) => /^\s*name\s*=\s*"notes"\s*$/m.test(entry));
const cargoLockVersion = cargoPackage?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];

const types = readFileSync(join(root, "src", "lib", "notes", "types.ts"), "utf8");
const desktopVite = readFileSync(join(root, "vite.desktop.config.ts"), "utf8");

let ok = true;

if (pkgVersion !== tauriVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != tauri.conf.json (${tauriVersion})`);
  ok = false;
}

if (pkgVersion !== cargoVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != Cargo.toml (${cargoVersion})`);
  ok = false;
}

if (pkgVersion !== packageLockVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != package-lock.json (${packageLockVersion})`);
  ok = false;
}

if (pkgVersion !== cargoLockVersion) {
  console.error(`❌ VERSION MISMATCH: package.json (${pkgVersion}) != Cargo.lock (${cargoLockVersion ?? "missing"})`);
  ok = false;
}

if (!types.includes("__APP_VERSION__")) {
  console.error("❌ VERSION DISPLAY MISSING: APP_VERSION is not injected into the app runtime.");
  ok = false;
}

if (!desktopVite.includes('JSON.stringify(pkg.version)')) {
  console.error("❌ VERSION DISPLAY MISSING: desktop build does not inject package.json version.");
  ok = false;
}

if (ok) {
  console.log(`✅ Version sync OK: all release files and the app UI are at v${pkgVersion}`);
  console.log("   package.json · package-lock.json · Cargo.toml · Cargo.lock · tauri.conf.json · APP_VERSION");
} else {
  console.error("");
  console.error("Fix: run the version bump script to sync all files:");
  console.error("  node scripts/bump-version.mjs <new-version>");
  process.exit(1);
}
