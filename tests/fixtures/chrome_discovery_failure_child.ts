import { launchChrome } from "../../scripts/proof-helper.ts";

// argv: <profile prefix> <puppeteer cache root>. The cache root is PASSED and the system candidates are
// EMPTY (audio-feed-rc0g8): the row this fixture serves proves what a machine with NO browser produces,
// and emptying the search is how that is asserted without moving /usr/bin/google-chrome out from under the
// browser suites running beside it.
const prefix = Deno.args[0] ?? "audiofeed-subp-missing-";
const chromeCacheRoot = Deno.args[1];
await launchChrome({ prefix, chromeCacheRoot, systemBinaries: [] });
