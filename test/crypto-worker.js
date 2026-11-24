import { runPushTests } from "./push.test.mjs";
export default {
  async fetch() {
    const lines = [];
    try {
      const r = await runPushTests(l => lines.push(l));
      return new Response(lines.join("\n") + `\n\n${r.pass} ok, ${r.fail} fehlgeschlagen\n`, { status: r.fail ? 500 : 200 });
    } catch (e) {
      return new Response(lines.join("\n") + "\n\nFEHLER: " + (e.stack || e), { status: 500 });
    }
  },
};
