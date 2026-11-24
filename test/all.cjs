// Alle Suiten nacheinander.
//   npm test              lokal gegen `wrangler dev`, schreibt und loescht
//   npm run test:staging  gegen die Probeumgebung, schreibt und loescht
//   npm run test:live     gegen die veroeffentlichte Instanz, nur lesend
const { execFileSync } = require("node:child_process");
const { PRODUCTION } = require("../scripts/guard.cjs");

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const host = (() => { try { return new URL(BASE).hostname; } catch { return ""; } })();
const isProduction = PRODUCTION.includes(host);

const suites = [
  ["API", "test/run.mjs"],
  ["Verschlüsselung (RFC 8291/8292)", "test/push.test.mjs"],
  ["Push von Ende zu Ende", "test/push-e2e.cjs"],
  ["Motivationsnachrichten", "test/nudge.test.cjs"],
  ["Gemeinsame Einheiten und Vorschläge", "test/social.cjs"],
  ["Guthaben", "test/bonus.cjs"],
  ["Rangliste", "test/board.cjs"],
  ["Import über intervals.icu", "test/icu.cjs"],
  ["Zahlen und Diagramme", "test/report.cjs"],
  ["Ändern und Löschen", "test/edit.cjs"],
  ["Feed filtern", "test/filter.cjs"],
  ["Kasse", "test/kasse.cjs"],
  ["Oberfläche im Browser", "test/ui.cjs"],
];

// --use-env-proxy immer: lokal unnoetig, aber harmlos; fuer Open-Meteo und
// die Probeumgebung noetig.
const run = (file) =>
  execFileSync(process.execPath, ["--use-env-proxy", file], { stdio: "inherit", cwd: __dirname + "/.." });

let failed = 0;

if (isProduction) {
  console.log("\n### Veröffentlichte Instanz – nur lesend");
  console.log("Die übrigen Suiten legen Teilnehmer an und löschen alle vorhandenen.");
  try { run("test/live.cjs"); } catch { failed++; }
} else {
  // Der Push-Teil braucht einen Push-Dienst, den der Worker erreichen kann.
  // Lokal ist das ein Server auf 127.0.0.1 - ein Worker in der Cloud kommt
  // da nicht hin, deshalb laufen diese Suiten nur lokal.
  const local = host === "127.0.0.1" || host === "localhost";
  const needsLocalPush = ["push-e2e", "nudge.test", "social", "bonus"];
  for (const [name, file] of suites) {
    if (!local && needsLocalPush.some((n) => file.includes(n))) {
      console.log(`\n### ${name}: übersprungen (braucht einen Push-Dienst auf diesem Rechner)`);
      continue;
    }
    console.log(`\n### ${name}`);
    try { run(file); } catch { failed++; }
  }
}

console.log(failed ? `\n${failed} Suite(n) fehlgeschlagen\n` : "\nAlles grün.\n");
process.exit(failed ? 1 : 0);
