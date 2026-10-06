// Evidence capture for audio-feed-0r0s (confirm-dialog client unification).
//
// Re-capture:  deno run -A docs/evidence/audio-feed-0r0s/capture.ts <output-file>
//
// Prints: the admin.js asset URL (content-addressed — it changes when the file
// changes), the confirm-client fragment exactly as the ACCOUNT page ships it
// inline (sliced from the page's own <script> block), and its sha256. Before
// and after the unification, the FRAGMENT's behavior must be unchanged; the
// bytes may differ only in comments/whitespace because the typed admin.js copy
// (now the single source) carries JSDoc the old shell string never had.
import { createHash } from "node:crypto";
import { CONFIRM_DIALOG_CLIENT } from "../../../src/routes/shell.ts";
import { assetUrl } from "../../../src/routes/assets.ts";
import { renderAccountPage } from "../../../src/routes/account.ts";
import { makeUser } from "../../../tests/fixtures.ts";

const out = Deno.args[0] ?? "/dev/stdout";
const html = renderAccountPage({
  user: makeUser({ id: "user-1", email: "test@example.com" }),
  baseUrl: "https://audio.example.com",
  rpId: "audio.example.com",
  sources: [],
  credentials: [],
  episodes: [],
  outdatedCount: 0,
  failedCount: 0,
  prefill: null,
});

// Slice the inline confirm fragment straight out of the rendered page, so the
// evidence is what a browser receives, not what a module exports. Shape-agnostic:
// from the confirmDialog binding (however wrapped) to the showModal call.
const fragmentMatch =
  /const confirmDialog =(?:(?!showModal\(\);)[\s\S])*confirmDialog\.showModal\(\);/.exec(html);
const tail = fragmentMatch ? fragmentMatch[0] : "";

const lines: string[] = [];
const add = (s = "") => lines.push(s);
add("# audio-feed-0r0s evidence capture");
add("# command: deno run -A docs/evidence/audio-feed-0r0s/capture.ts <out>");
add();
add("=== admin.js asset URL (content-addressed) ===");
add(assetUrl("admin.js"));
add();
add("=== shell.ts CONFIRM_DIALOG_CLIENT export: length + sha256 ===");
const exportBody = CONFIRM_DIALOG_CLIENT;
add(`length=${exportBody.length} sha256=${createHash("sha256").update(exportBody).digest("hex")}`);
add();
add("=== confirm fragment as served inline on the account page ===");
add(`present=${tail !== ""} sha256=${createHash("sha256").update(tail).digest("hex")}`);
add(tail);
await Deno.writeTextFile(out, lines.join("\n") + "\n");
console.log(`wrote ${out}`);
