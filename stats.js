// Die Abrechnung einer Woche - einmal an einer Stelle, damit App, Push und
// Anstupser nie unterschiedlich rechnen.

export function weekOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export const addWeeks = (w, n) => {
  const d = new Date(w + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
};

// Was in einer Woche zusammenkommt, bevor Guthaben ins Spiel kommt.
function rawWeek(entries, memberId, week, sickMax) {
  let done = 0, sickUnits = 0;
  for (const e of entries) {
    if (e.member_id !== memberId || weekOf(e.date) !== week) continue;
    if (e.kind === "sick") sickUnits += e.units || 1;
    else done++;
  }
  return { done, sickUnits, base: done + Math.min(sickUnits, sickMax) };
}

// Was eine zusätzliche Einheit wert ist: die erste über dem Ziel einen ganzen
// Punkt, die zweite einen halben, die dritte 0,3 – danach nichts mehr.
export const CREDIT_STEPS = [1, 0.5, 0.3];
export const MAX_CREDITS = 9;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export function creditsEarned(done, required) {
  let sum = 0;
  for (let i = 0; i < done - required; i++) sum += CREDIT_STEPS[i] ?? 0;
  return round1(sum);
}

/**
 * Rechnet jede Person durch, Woche für Woche in zeitlicher Reihenfolge.
 *
 * Guthaben entsteht nur aus echten Einheiten über dem Wochenziel und ist bei
 * MAX_CREDITS gedeckelt. Eingesetzt wird es automatisch und nur dann, wenn die
 * Woche sonst verloren wäre – und auch dann nie für die ganze Woche:
 * mindestens ein eigener Eintrag muss stehen, Sport oder Krankmeldung.
 *
 * Die zeitliche Reihenfolge ist der Kern: Guthaben muss in der Woche, die es
 * rettet, schon dagewesen sein. Rückwirkend geht nichts.
 */
export function settle({ members, entries, expenses = [], settings, today }) {
  const required = Math.max(1, Number(settings.required) || 2);
  const sickMax = Number.isFinite(settings.sickMax) ? settings.sickMax : required;
  const cost = Math.max(1, Number(settings.bonusCost) || 3);
  const bonusOn = !!settings.bonus;
  // Gesammelt wird erst ab dem Tag, an dem die Regel eingeschaltet wurde -
  // sonst gaebe es beim Einschalten rueckwirkend ein Guthaben aus alten Wochen.
  const bonusFrom = bonusOn && settings.bonusSince ? weekOf(settings.bonusSince) : null;
  const cur = weekOf(today);
  const out = {};

  for (const m of members) {
    const from = weekOf(m.joined && m.joined > settings.start ? m.joined : settings.start);
    let credits = 0, missed = 0, weeks = 0, saved = 0, spent = 0;
    const okWeeks = [];

    for (let w = from, i = 0; w < cur && i < 520; w = addWeeks(w, 1), i++) {
      const { done, sickUnits, base } = rawWeek(entries, m.id, w, sickMax);
      weeks++;
      if (base >= required) {
        if (bonusOn && (!bonusFrom || w >= bonusFrom))
          credits = round1(Math.min(MAX_CREDITS, credits + creditsEarned(done, required)));
        okWeeks.push(w);
        continue;
      }
      const need = required - base;
      // Mindestens ein eigener Eintrag muss stehen - Sport oder Krankmeldung.
      const anyEntry = done + sickUnits >= 1;
      const mayCover = bonusOn && anyEntry && need <= required - 1 && credits >= need * cost;
      if (mayCover) {
        credits = round1(credits - need * cost);
        spent = round1(spent + need * cost);
        saved++;
        okWeeks.push(w);
      } else {
        missed++;
      }
    }

    // Laufende Woche
    const now = rawWeek(entries, m.id, cur, sickMax);
    const left = Math.max(0, required - now.base);
    const pending = bonusOn ? Math.min(MAX_CREDITS - credits, creditsEarned(now.done, required)) : 0;
    const canRescue = bonusOn && now.done + now.sickUnits >= 1 && left > 0 && left <= required - 1 && credits >= left * cost;

    let streak = 0;
    if (now.base >= required) streak++;
    for (let w = addWeeks(cur, -1), i = 0; w >= from && i < 520; w = addWeeks(w, -1), i++) {
      if (okWeeks.includes(w)) streak++;
      else break;
    }

    out[m.id] = {
      // Nur was seit dem Start der Challenge passiert ist - und nicht, bevor
      // die Person dabei war.
      sessions: entries.filter(
        (e) => e.member_id === m.id && e.kind !== "sick" && weekOf(e.date) >= from
      ).length,
      weeks, missed, saved, spent,
      // Was zusammengekommen ist, was die Person davon schon ausgelegt hat,
      // und was unterm Strich bleibt. Niemand zahlt in einen Topf ein - wer
      // etwas fuer die Gruppe bezahlt, begleicht damit seine Schulden.
      owed: round2(missed * (Number(settings.fine) || 0)),
      settled: round2(expenses.filter((x) => x.member_id === m.id).reduce((a, x) => a + (Number(x.amount) || 0), 0)),
      credits, pending: round1(Math.max(0, pending)), streak, maxCredits: MAX_CREDITS,
      week: { done: now.done, sick: now.sickUnits, credit: now.base, left, canRescue },
      rescueCost: left * cost,
    };
    out[m.id].balance = round2(out[m.id].settled - out[m.id].owed);
  }
  return out;
}
