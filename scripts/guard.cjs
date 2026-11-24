// Ein Ort, an dem entschieden wird, wogegen ein schreibender Test laufen darf.
// Wird von jeder Suite ganz oben aufgerufen.

const PRODUCTION = ["das-programm.phil89.workers.dev"];
const STAGING = ["das-programm-test.phil89.workers.dev"];

function hostOf(base) {
  try { return new URL(base).hostname; } catch { return ""; }
}

/**
 * Bricht ab, wenn die Suite Daten anlegen und loeschen wuerde, BASE aber auf
 * etwas zeigt, das echte Daten enthaelt.
 *
 * Erlaubt: localhost und 127.0.0.1 immer, die Probeumgebung nur mit
 * ALLOW_STAGING_WIPE=1. Die veroeffentlichte Instanz nie - auch nicht mit
 * gesetzter Variable.
 */
function requireScratchTarget(base) {
  const host = hostOf(base);
  const stop = (why) => {
    console.error("\n⛔ Abgebrochen: " + why);
    console.error("   BASE = " + base);
    console.error("   Diese Testsuite legt Teilnehmer an und loescht alle vorhandenen.");
    console.error("   Lokal:        npm test");
    console.error("   Probeumgebung: npm run test:staging");
    console.error("   Gegen die veroeffentlichte Instanz laeuft nur npm run test:live (nur lesend).\n");
    process.exit(2);
  };

  if (!host) stop("BASE ist keine gueltige Adresse.");
  if (PRODUCTION.includes(host)) stop("das ist die veroeffentlichte Instanz mit den echten Daten.");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  if (STAGING.includes(host)) {
    if (process.env.ALLOW_STAGING_WIPE === "1") return;
    stop("die Probeumgebung wird nur mit ALLOW_STAGING_WIPE=1 geleert.");
  }
  stop("unbekanntes Ziel - schreibende Tests laufen nur lokal oder in der Probeumgebung.");
}

module.exports = { requireScratchTarget, PRODUCTION, STAGING };
