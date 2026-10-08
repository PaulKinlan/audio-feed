/**
 * Shared access to the player's client code and data (audio-feed-3xq).
 *
 * Before this change the client lived inside the page's HTML, so a test could assert on the page
 * text. That is exactly what made the client invisible to `deno check` and `deno lint`, and the fix
 * moved it to a content-addressed asset. These helpers let the tests that CARE about client code keep
 * caring — about the file that now contains it — instead of about a string in a template literal.
 */

/** The URL the page links for a given asset, so a test follows the real address, not a guess. */
export function linkedAsset(html: string, suffix: string): string | null {
  // The address is /assets/<hash>.<name>, and the name itself contains a dot
  // ("c5f2e3e4.listen.js"), so the pattern must not assume the hash is adjacent to the suffix.
  const match = new RegExp(`src="(/assets/[0-9a-f]+\\.[^"]+\\.${suffix})"`).exec(html);
  return match?.[1] ?? null;
}

/** Fetch the player's client source through the page's own link. */
export async function playerClient(
  fetch: (req: Request) => Promise<Response>,
  base: string,
  html: string,
): Promise<string> {
  const url = linkedAsset(html, "js");
  if (!url) throw new Error("the page does not link a client asset");
  const res = await fetch(new Request(`${base}${url}`));
  if (!res.ok) throw new Error(`client asset responded ${res.status}`);
  return await res.text();
}

/**
 * The JSON document the page hands the client. This is the server's contract with the browser, so
 * asserting on it is asserting on something real rather than on source text.
 */
export function playerData(html: string): {
  token?: string;
  origin?: string;
  episodes?: { id: string; title: string; audioUrl: string }[];
  activity?: {
    inProgress?: { id: string; title: string }[];
    failed?: { id: string; title: string }[];
    playable?: number;
  };
} {
  const match =
    /<script\b[^>]*type="application\/json"[^>]*id="player-data"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  const body = match?.[1];
  if (body === undefined) throw new Error("the page carries no #player-data document");
  return JSON.parse(body);
}
