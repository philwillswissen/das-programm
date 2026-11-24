// Alle Suiten nacheinander gegen BASE (Standard: http://127.0.0.1:8787).
const { execFileSync } = require("node:child_process");
const suites = [
  ["API", "test/run.mjs"],
  ["Verschlüsselung (RFC 8291/8292)", "test/push.test.mjs"],
  ["Push von Ende zu Ende", "test/push-e2e.cjs"],
  ["Motivationsnachrichten", "test/nudge.test.cjs"],
  ["Gemeinsame Einheiten und Vorschlaege", "test/social.cjs"],
  ["Guthaben", "test/bonus.cjs"],
  ["Oberfläche im Browser", "test/ui.cjs"],
];
let failed = 0;
for (const [name, file] of suites) {
  const live = (process.env.BASE || "").startsWith("https://");
  if (live && (file.includes("push-e2e") || file.includes("nudge.test") || file.includes("social") || file.includes("bonus"))) { console.log(`\n### ${name}: übersprungen (braucht einen lokalen Push-Dienst)`); continue; }
  console.log(`\n### ${name}`);
  try {
    execFileSync(process.execPath, live ? ["--use-env-proxy", file] : [file], { stdio: "inherit", cwd: __dirname + "/.." });
  } catch { failed++; }
}
console.log(failed ? `\n${failed} Suite(n) fehlgeschlagen\n` : "\nAlles grün.\n");
process.exit(failed ? 1 : 0);
