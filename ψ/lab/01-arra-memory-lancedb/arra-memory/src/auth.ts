import { verifyBearer } from "./oauth";
import { verifySession } from "./session";
import { readCookie, timingSafeEqual } from "./utils";
import { SESSION_COOKIE_NAME } from "./session";

/**
 * One gate, three keys.
 *
 * Different callers can prove themselves in different ways, and no single
 * mechanism serves them all:
 *
 *   owner-session   The web UI. A cookie, because a browser has one and cannot
 *                   be trusted to hold a bearer token in script.
 *   api-token       curl, scripts, and MCP clients that read a config file —
 *                   Claude Code can send a static header, so it should.
 *   oauth           claude.ai connectors. They cannot send a static header at
 *                   all; OAuth is the only door open to them. This is the
 *                   reason the whole oauth.ts exists.
 *
 * All three land on the same corpus with the same rights. The distinction is
 * how the caller proved it is the owner, not what it may then do.
 */

export type AuthMethod = "owner-session" | "api-token" | "oauth";

export interface AuthResult {
  ok: boolean;
  method?: AuthMethod;
  clientId?: string;
  scope?: string;
}

const DENIED: AuthResult = { ok: false };

export interface AuthConfig {
  /** The owner passphrase. Signs sessions and approves OAuth clients. */
  ownerPassphrase: string;
  /** Optional static bearer for scripts and local MCP clients. */
  apiToken?: string;
}

export async function authenticate(
  request: Request,
  config: AuthConfig,
): Promise<AuthResult> {
  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ")) {
    const presented = authorization.slice(7).trim();

    // Static token first: it is one comparison, whereas the OAuth path is a
    // database round trip. Compared in constant time — a bearer token is a
    // secret, and `===` leaks how much of it was right.
    if (config.apiToken && (await timingSafeEqual(presented, config.apiToken))) {
      return { ok: true, method: "api-token" };
    }

    const token = await verifyBearer(authorization);
    if (token) {
      return {
        ok: true,
        method: "oauth",
        clientId: token.clientId,
        scope: token.scope,
      };
    }

    // A Bearer header that matched neither is a definite no. Falling through to
    // the cookie here would let a stale token silently ride an open session and
    // report the wrong method.
    return DENIED;
  }

  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (await verifySession(config.ownerPassphrase, cookie)) {
    return { ok: true, method: "owner-session" };
  }

  return DENIED;
}

/**
 * The 401 body. `WWW-Authenticate` carries the resource-metadata pointer an MCP
 * client follows to discover the OAuth endpoints — without it, claude.ai has no
 * way to learn where /authorize lives and simply reports a failed connection.
 */
export function unauthorized(origin: string): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Authentication required." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        // realm/error/error_description are what RFC 6750 defines for a 401,
        // and the resource_metadata pointer is RFC 9728's discovery hook —
        // suffixed with the resource path, which is where a client looks.
        "www-authenticate":
          `Bearer realm="OAuth", ` +
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
          `error="invalid_token", ` +
          `error_description="Missing or invalid access token"`,
        // The 401 is the message that starts the whole OAuth dance, so its
        // headers must survive a cross-origin read like any other response.
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "www-authenticate",
      },
    },
  );
}
