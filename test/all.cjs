// Alle Suiten nacheinander. Lokal (Standard) wird geschrieben und geloescht,
// gegen die laufende Instanz wird ausschliesslich gelesen.
const { execFileSync } = require("node:child_process");
const live = /^https:\/\//.test(process.env.BASE || "");

const suites = [
  ["API", "test/run.mjs"],
  ["Verschlüsselung (RFC 8291/8292)", "test/push.test.mjs"],
  ["Push von Ende zu Ende", "test/push-e2e.cjs"],
  ["Motivationsnachrichten", "test/nudge.test.cjs"],
  ["Gemeinsame Einheiten und Vorschläge", "test/social.cjs"],
  ["Guthaben", "test/bonus.cjs"],
  ["Oberfläche im Browser", "test/ui.cjs"],
];

const run = (file, extra = []) =>
  execFileSync(process.execPath, [...extra, file], { stdio: "inherit", cwd: __dirname + "/.." });

let failed = 0;

if (live) {
  console.log("\n### Laufende Instanz (nur lesend)");
  console.log("Die übrigen Suiten leeren die Datenbank und laufen deshalb nur lokal.");
  try { run("test/live.cjs", ["--use-env-proxy"]); } catch { failed++; }
} else {
  for (const [name, file] of suites) {
    console.log(`\n### ${name}`);
    try { run(file); } catch { failed++; }
  }
}

console.log(failed ? `\n${failed} Suite(n) fehlgeschlagen\n` : "\nAlles grün.\n");
process.exit(failed ? 1 : 0);
