import { launchChrome } from "../../scripts/proof-helper.ts";

const prefix = Deno.args[0] ?? "audiofeed-subp-missing-";
await launchChrome({ prefix });
