#!/usr/bin/env node
// Sichert die veroeffentlichte Datenbank in backups/ (nicht im Repo).
// Vor jeder Schemaaenderung und vor jedem groesseren Deploy ausfuehren:
//
//   npm run backup
//
const { spawnSync } = require("node:child_process");
const { mkdirSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, "..", "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(dir, `sportkasse-${stamp}.sql`);

const res = spawnSync("npx", ["wrangler", "d1", "export", "sportkasse", "--remote", "--output", out], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});
if (res.status !== 0) {
  console.error("\nSicherung fehlgeschlagen.");
  process.exit(res.status ?? 1);
}

const size = statSync(out).size;
console.log(`\nGesichert: ${out} (${(size / 1024).toFixed(1)} KB)`);
console.log(`Vorhandene Sicherungen: ${readdirSync(dir).filter((f) => f.endsWith(".sql")).length}`);
console.log("Zurueckspielen notfalls mit: npx wrangler d1 time-travel restore sportkasse --timestamp=...");
