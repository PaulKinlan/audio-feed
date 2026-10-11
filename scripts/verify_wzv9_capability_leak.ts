// Re-runs the P1 finding's own reproduction against the real app, widened to every malformed shape
// the finding names. Exits non-zero on any leak.
import { openStores } from "../src/config.ts";
import { bootstrap } from "../src/server.ts";

const TOKEN = "kR7fQ2mZ8pLx4Vn1Tb6Ys3Wd";
const stores = await openStores({ kvPath: ":memory:" });
const app = await bootstrap({
  port: 0,
  stores,
  isDeploy: true,
  synthesizer: null,
  inventory: false,
});
const paths = [
  `/feed/${TOKEN}/master.xml/${TOKEN}`,
  `/feed/${TOKEN}`,
  `/listen/${TOKEN}`,
  `/listen/${TOKEN}/extra`,
  `/audio/${TOKEN}/foo/bar`,
  `/feed//${TOKEN}//master.xml`,
  `/feed/${encodeURIComponent(TOKEN)}/master.xml`,
  `/feed/${TOKEN}%2Fmore`,
  `/${TOKEN}/anything`,
  `/feed/${TOKEN}/master.xml?token=${TOKEN}`,
];
let leaks = 0;
try {
  for (const path of paths) {
    const res = await app.fetch(new Request(`http://localhost${path}`));
    const logs = await stores.metadata.listLogs();
    const serialised = JSON.stringify(logs);
    const leaked = serialised.includes(TOKEN) ||
      serialised.includes(encodeURIComponent(TOKEN)) ||
      serialised.includes(encodeURIComponent(TOKEN).toLowerCase());
    if (leaked) leaks++;
    console.log(
      `${leaked ? "LEAK" : "safe"}  ${String(res.status).padEnd(3)} route=${
        logs[logs.length - 1]?.route
      }  ${path}`,
    );
  }
} finally {
  await app.shutdown();
}
console.log(
  leaks === 0 ? "\nNo stored record contains the capability, in any shape." : `\n${leaks} LEAK(S)`,
);
Deno.exit(leaks === 0 ? 0 : 1);

/**
 * This is the P1 finding's own reproduction (audio-feed-pwu4), widened to every malformed shape it
 * names, and it drives the REAL app: openStores + bootstrap, the same path a request takes in
 * production. It exists because the leak was found on that path and not by the unit test that was
 * supposed to cover it — the unit test asserted the shapes I had thought of.
 */
