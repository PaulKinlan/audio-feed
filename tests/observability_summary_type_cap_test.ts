import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/app.ts";
import { createHandlers } from "../src/compose.ts";
import { memoryStores } from "../src/config.ts";

const BASE = "https://audio.example";
const KEY = "local-summary-test-key";

for (const otherTypes of [24, 25]) {
  const cut = otherTypes === 25;
  Deno.test(`qyyk: ${cut ? "cut" : "uncut"} rare claim expiry reports type-cap truth`, async () => {
    const stores = memoryStores();
    try {
      const config = {
        port: 8000,
        publicBaseUrl: BASE,
        adminToken: "local-admin-test-token",
        observabilityKey: KEY,
      };
      const ctx = { config, stores };
      const fetch = createApp(ctx, createHandlers(ctx)).fetch;
      // Each competing type has two warnings, so the one claim.lifecycle expiry is last by COUNT.
      // 24 competitors => 25 returned types; 25 competitors => the 26th type is omitted.
      for (let i = 0; i < otherTypes; i++) {
        for (let j = 0; j < 2; j++) {
          assert(
            await stores.metadata.appendLog({
              time: "2026-10-14T12:00:00.000Z",
              severity: "warn",
              type: `a${String(i).padStart(2, "0")}`,
              process: "worker",
              message: "synthetic competitor",
            }),
          );
        }
      }
      assert(
        await stores.metadata.appendLog({
          time: "2026-10-14T12:00:01.000Z",
          severity: "warn",
          type: "claim.lifecycle",
          process: "storage",
          message: "claim lease expired",
          context: { claimOutcome: "expired", workerState: "unknown" },
        }),
      );

      const response = await fetch(
        new Request(`${BASE}/api/observability/summary?since=0`, {
          headers: { authorization: `Bearer ${KEY}` },
        }),
      );
      assertEquals(response.status, 200);
      const body = await response.json();
      const count = otherTypes * 2 + 1;
      assertEquals(body.total, count);
      assertEquals(body.bySeverity.warn, count);
      assertEquals(body.scanned, count);
      assertEquals(body.cursor, String(count));
      assertEquals(
        body.truncated,
        false,
        "every record was scanned: this is NOT cursor truncation",
      );
      assertEquals(body.byType.length, 25, "the bounded top-25 remains in force");
      assertEquals(
        body.byType.some((entry: { type: string }) => entry.type === "claim.lifecycle"),
        !cut,
      );
      assertEquals(body.byTypeTruncated, cut, "the flag distinguishes absent from cut");

      const errorsOnly = await fetch(
        new Request(`${BASE}/api/observability/summary?since=0&severity=error`, {
          headers: { authorization: `Bearer ${KEY}` },
        }),
      );
      assertEquals(errorsOnly.status, 200);
      const filtered = await errorsOnly.json();
      assertEquals(filtered.scanned, count);
      assertEquals(filtered.total, 0, "all warnings are excluded by the counted severity filter");
      assertEquals(filtered.byType, []);
      assertEquals(filtered.byTypeTruncated, false, "uncounted types must not look omitted");
    } finally {
      await stores.metadata.close();
    }
  });
}
