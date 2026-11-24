#!/usr/bin/env node
// Zugriff auf eine der beiden Datenbanken von der Kommandozeile.
//
//   npm run db -- "SELECT count(*) FROM entries"           -> veroeffentlicht, nur lesend
//   npm run db:staging -- "DELETE FROM members"            -> Probeumgebung, alles erlaubt
//
// Gegen die veroeffentlichte Datenbank sind ausschliesslich Abfragen moeglich.
// Es gibt keinen Schalter, der das aufhebt: Schemaaenderungen macht der Worker
// selbst (migrate() in worker.js), und Daten gehoeren den Leuten, die sie
// eingetragen haben.
const { spawnSync } = require("node:child_process");

const PROD = "sportkasse";
const STAGING = "sportkasse-test";
const READ_ONLY = /^\s*(select|pragma|explain|with)\b/i;

const staging = process.argv.includes("--staging");
const sql = process.argv.slice(2).filter((a) => a !== "--staging").join(" ").trim();
const db = staging ? STAGING : PROD;

if (!sql) {
  console.error('Nutzung: npm run db -- "SELECT ..."');
  process.exit(1);
}

if (!staging && !READ_ONLY.test(sql)) {
  console.error("\n⛔ Abgelehnt.");
  console.error("   " + sql);
  console.error("\n   Gegen " + PROD + " sind nur Abfragen erlaubt (SELECT, PRAGMA, EXPLAIN).");
  console.error("   Dort liegen die echten Eintraege der Gruppe.");
  console.error("   Zum Ausprobieren: npm run db:staging -- \"" + sql + '"');
  console.error("   Schemaaenderungen macht der Worker beim Start selbst.\n");
  process.exit(2);
}

const res = spawnSync("npx", ["wrangler", "d1", "execute", db, "--remote", "--command", sql], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});
process.exit(res.status ?? 1);
