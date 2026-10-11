/**
 * Conformance suite for `MetadataStore`.
 *
 * Every adapter must pass this identically. If an adapter needs a carve-out,
 * the interface is wrong — fix the interface, do not weaken the suite.
 *
 * The cases live in one module per domain under `./metadata/` (audio-feed-fydf); this file is the
 * entry point the adapters are wired through, and it is deliberately only a list: adding a domain
 * means adding its module here, and a module that is not listed registers nothing (which the
 * case manifest on audio-feed-fydf is what catches).
 *
 * Owned by: audio-feed-0h8.
 */

import { createMetadataHarness, type MetadataSuiteOptions } from "./metadata/harness.ts";
import { registerUsersCases } from "./metadata/users.ts";
import { registerSourcesCases } from "./metadata/sources.ts";
import { registerArticlesCases } from "./metadata/articles.ts";
import { registerEpisodesQueueCases } from "./metadata/episodes-queue.ts";
import { registerEpisodesClaimsCases } from "./metadata/episodes-claims.ts";
import { registerEpisodesRegenerationCases } from "./metadata/episodes-regeneration.ts";
import { registerUsageCases } from "./metadata/usage.ts";
import { registerNotificationsCases } from "./metadata/notifications.ts";
import { registerAuthCases } from "./metadata/auth.ts";
import { registerSegmentsCases } from "./metadata/segments.ts";
import { registerRepositoriesCases } from "./metadata/repositories.ts";
import { registerLifecycleLogCases, registerLogsCases } from "./metadata/logs.ts";

export type { MetadataSuiteOptions };

export function runMetadataConformance(options: MetadataSuiteOptions) {
  const suite = createMetadataHarness(options);
  registerUsersCases(suite);
  registerSourcesCases(suite);
  registerArticlesCases(suite);
  registerEpisodesQueueCases(suite);
  registerEpisodesClaimsCases(suite);
  registerEpisodesRegenerationCases(suite);
  registerUsageCases(suite);
  registerNotificationsCases(suite);
  registerAuthCases(suite);
  registerSegmentsCases(suite);
  registerRepositoriesCases(suite);
  registerLogsCases(suite);
  registerLifecycleLogCases(suite);
}
