/**
 * Port resolution for proof harnesses (audio-feed-vc4u, mkn3, bm58).
 *
 * Extracted from scripts/account-harness.ts so that it is a PURE function a
 * test can import and assert WITHOUT spawning a server. The previous
 * arrangement could only be checked by spawning a harness, so the row that
 * named this contract carried `ignore: permissions.run !== granted` - it was
 * silent in exactly the environment the fast gate runs in.
 *
 * The rule, and the reason this file exists: AN EXPLICIT VALUE ALWAYS BEATS A
 * DEFAULT. The pinned default exists so committed evidence stops embedding an
 * OS-assigned port number, but it must not shadow a caller who has said what
 * they want. spawnHarness passes "0" meaning "bind an ephemeral port", and a
 * filter of /^[1-9]\d*$/ rejected it, so every concurrent proof shared the
 * pinned port instead of getting its own.
 */

/** Fixed port used when neither an argument nor the env var says otherwise. */
export const HARNESS_PORT_DEFAULT = 8133;

/**
 * Resolve the port a harness should bind.
 *
 * Precedence: `ephemeral`/`0` env, a numeric env value, a `0` or positive
 * integer argument, then {@link HARNESS_PORT_DEFAULT}. 0 means "bind an
 * ephemeral port" and is a VALID EXPLICIT VALUE, not an absent one.
 */
export function resolveHarnessPort(
  args: ReadonlyArray<string>,
  envValue: string | undefined,
  defaultPort: number = HARNESS_PORT_DEFAULT,
): number {
  if (envValue === "ephemeral" || envValue === "0") return 0;
  if (envValue && /^\d+$/.test(envValue)) return Number(envValue);
  const cliPort = args.find((a) => /^(?:0|[1-9]\d*)$/.test(a));
  if (cliPort !== undefined) return Number(cliPort);
  return defaultPort;
}
