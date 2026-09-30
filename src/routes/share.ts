/**
 * W3C Web Share Target route (audio-feed-vtiy).
 *
 * Receives shared URLs/text from the OS share dialog via installed PWA
 * (share_target declaration in manifest.json), resolves the article link,
 * and routes authenticated subscribers to their unified quick-add panel.
 *
 * TODO(baseline/app-share-targets): drop when Web Share Target reaches Baseline.
 */
import type { RouteContext } from "../router.ts";
import type { AppContext } from "../app.ts";
import { sessionUser } from "../auth/sessions.ts";

/** Validate whether a string is a valid http/https web URL. */
export function isValidWebUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Extracts a target article URL from Web Share Target parameters.
 * Handles both standard `url` parameters and Android shares where the URL
 * is embedded within the `text` parameter.
 */
export function extractUrlFromShare(
  urlParam: string | null | undefined,
  textParam: string | null | undefined,
): string | null {
  if (urlParam) {
    const trimmed = urlParam.trim();
    if (isValidWebUrl(trimmed)) return trimmed;
  }

  if (textParam) {
    const trimmed = textParam.trim();
    if (isValidWebUrl(trimmed)) return trimmed;

    // Mobile platforms (especially Android) often share URLs within text
    // e.g. "Check out this article https://example.com/post"
    const match = trimmed.match(/https?:\/\/[^\s]+/i);
    if (match) {
      // Strip trailing punctuation often attached to URLs in natural language
      const candidate = match[0].replace(/[.,!?;:)]+$/, "");
      if (isValidWebUrl(candidate)) return candidate;
    }
  }

  return null;
}

/** Handles incoming GET /share requests from the PWA Web Share Target. */
export async function handleShare({ ctx, req }: RouteContext<AppContext>): Promise<Response> {
  const reqUrl = new URL(req.url);
  const rawUrl = reqUrl.searchParams.get("url");
  const rawText = reqUrl.searchParams.get("text");
  const rawTitle = reqUrl.searchParams.get("title") ?? "";

  const targetUrl = extractUrlFromShare(rawUrl, rawText);
  const cleanTitle = rawTitle.slice(0, 200).trim();

  const user = await sessionUser(ctx.stores.metadata, req);

  if (targetUrl) {
    const targetPath = `/account?add=${encodeURIComponent(targetUrl)}${
      cleanTitle ? `&title=${encodeURIComponent(cleanTitle)}` : ""
    }`;

    if (user) {
      return new Response(null, {
        status: 303,
        headers: {
          location: targetPath,
          "cache-control": "no-store",
        },
      });
    }

    return new Response(null, {
      status: 303,
      headers: {
        location: `/login?next=${encodeURIComponent(targetPath)}`,
        "cache-control": "no-store",
      },
    });
  }

  // Fallback when no URL could be determined from the share payload
  const fallback = user ? "/account" : `/login?next=${encodeURIComponent("/account")}`;
  return new Response(null, {
    status: 303,
    headers: {
      location: fallback,
      "cache-control": "no-store",
    },
  });
}
