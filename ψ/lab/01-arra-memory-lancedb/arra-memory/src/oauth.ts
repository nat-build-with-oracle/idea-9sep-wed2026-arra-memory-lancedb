import { lit, scan, table } from "./db";
import { nowIso, nowSeconds, randomToken, sha256Base64Url } from "./utils";

/**
 * A minimal OAuth 2.1 authorization server — enough for an MCP client, and no
 * more.
 *
 * The hosted version leaned on @cloudflare/workers-oauth-provider. Off
 * Cloudflare, this file is what replaces it. It implements only what the MCP
 * spec actually requires of a remote server:
 *
 *   - Dynamic Client Registration (RFC 7591), because claude.ai registers
 *     itself rather than being configured by hand.
 *   - Authorization Code + PKCE S256 (RFC 7636). `plain` is refused outright;
 *     it offers no protection and OAuth 2.1 drops it.
 *   - Discovery at /.well-known/oauth-authorization-server (RFC 8414), which
 *     is how a client finds the three endpoints below.
 *
 * Deliberately absent: refresh tokens, client secrets, multi-user accounts,
 * consent scoping. One owner, one passphrase, one corpus.
 */

const CODE_TTL_SECONDS = 10 * 60; // one round trip, not a session
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export interface TokenInfo {
  token: string;
  clientId: string;
  scope: string;
}

// ── discovery ─────────────────────────────────────────────────────────────────

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    // S256 only. Advertising "plain" would invite a client to use it.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["memory:read", "memory:write"],
  };
}

// ── dynamic client registration ───────────────────────────────────────────────

export async function registerClient(input: {
  client_name?: string;
  redirect_uris?: string[];
}): Promise<RegisteredClient> {
  const redirectUris = (input.redirect_uris ?? []).filter(
    (uri) => typeof uri === "string" && uri.length > 0,
  );
  if (redirectUris.length === 0) {
    throw new Error("redirect_uris is required");
  }

  const clientId = randomToken(16);
  const clientName = input.client_name?.slice(0, 120) ?? null;

  const t = await table("oauth_clients");
  await t.add([
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: JSON.stringify(redirectUris),
      created_at: nowIso(),
    },
  ]);

  // No client_secret is issued: a public client cannot keep one, and PKCE is
  // what actually binds the code to the client that requested it.
  return { clientId, clientName, redirectUris };
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  created_at: string;
}

function parseRedirects(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const t = await table("oauth_clients");
  const [row] = await scan<ClientRow>(t, { where: `client_id = ${lit(clientId)}`, limit: 1 });
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    redirectUris: parseRedirects(row.redirect_uris),
  };
}

/**
 * Exact-match only. Prefix matching is the classic open-redirect in OAuth: a
 * client registered for `https://x.com/cb` must not be able to receive a code
 * at `https://x.com/cb.attacker.net` or `https://x.com/cb/../elsewhere`.
 */
export function isRegisteredRedirect(
  client: RegisteredClient,
  redirectUri: string,
): boolean {
  return client.redirectUris.includes(redirectUri);
}

// ── authorization code ────────────────────────────────────────────────────────

export async function issueCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  if (input.codeChallengeMethod !== "S256") {
    throw new Error("code_challenge_method must be S256");
  }
  if (!input.codeChallenge) {
    throw new Error("code_challenge is required");
  }

  const code = randomToken(32);
  const t = await table("oauth_codes");
  await t.add([
    {
      code,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      scope: input.scope,
      expires_at: nowSeconds() + CODE_TTL_SECONDS,
    },
  ]);
  return code;
}

interface CodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: number;
}

/**
 * Exchanges a code for a token.
 *
 * The code is deleted before the token is minted, whatever the outcome —
 * an authorization code is single-use, and a failed exchange must burn it too.
 * Otherwise an attacker who intercepts a code gets unlimited attempts at
 * guessing the verifier.
 */
export async function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; scope: string; expiresIn: number }> {
  const codes = await table("oauth_codes");
  const [row] = await scan<CodeRow>(codes, {
    where: `code = ${lit(input.code)} AND expires_at > ${nowSeconds()}`,
    limit: 1,
  });

  if (!row) throw new Error("invalid_grant");

  await codes.delete(`code = ${lit(input.code)}`);

  // The code was issued to one client, for one redirect_uri. Both must match
  // the exchange, or a different client could redeem a code it observed.
  if (row.client_id !== input.clientId) throw new Error("invalid_grant");
  if (row.redirect_uri !== input.redirectUri) throw new Error("invalid_grant");

  // PKCE: only the requester knows the verifier whose SHA-256 is the challenge.
  const computed = await sha256Base64Url(input.codeVerifier);
  if (computed !== row.code_challenge) throw new Error("invalid_grant");

  const accessToken = randomToken(32);
  const tokens = await table("oauth_tokens");
  await tokens.add([
    {
      token: accessToken,
      client_id: row.client_id,
      scope: row.scope,
      created_at: nowIso(),
      expires_at: nowSeconds() + TOKEN_TTL_SECONDS,
    },
  ]);

  return { accessToken, scope: row.scope, expiresIn: TOKEN_TTL_SECONDS };
}

// ── bearer verification ───────────────────────────────────────────────────────

interface TokenRow {
  token: string;
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: number | null;
}

/** Only tokens that have not lapsed. The clock is in the filter, never in JS after. */
const liveTokens = () => `expires_at IS NULL OR expires_at > ${nowSeconds()}`;

export async function verifyBearer(header: string | null): Promise<TokenInfo | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  const t = await table("oauth_tokens");
  const [row] = await scan<TokenRow>(t, {
    where: `token = ${lit(token)} AND (${liveTokens()})`,
    limit: 1,
  });

  return row ? { token: row.token, clientId: row.client_id, scope: row.scope } : null;
}

export async function revokeToken(token: string): Promise<void> {
  const t = await table("oauth_tokens");
  await t.delete(`token = ${lit(token)}`);
}

/** Housekeeping: drop codes and tokens already past their deadline. */
export async function sweepExpired(): Promise<void> {
  const now = nowSeconds();
  const codes = await table("oauth_codes");
  const tokens = await table("oauth_tokens");
  await codes.delete(`expires_at <= ${now}`);
  await tokens.delete(`expires_at IS NOT NULL AND expires_at <= ${now}`);
}

/** Every registered client with its live-token count — the "who has access" view. */
export async function listClients(): Promise<
  Array<{
    clientId: string; clientName: string | null; createdAt: string;
    activeTokens: number; lastTokenAt: string | null; scope: string | null;
  }>
> {
  const clients = await scan<ClientRow>(await table("oauth_clients"));
  const tokens = await scan<TokenRow>(await table("oauth_tokens"), { where: liveTokens() });

  // A LEFT JOIN, by hand: a registered client with no surviving tokens still
  // appears — "connected once, nothing active" is information.
  const byClient = new Map<string, TokenRow[]>();
  for (const t of tokens) {
    const list = byClient.get(t.client_id) ?? [];
    list.push(t);
    byClient.set(t.client_id, list);
  }

  return clients
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((c) => {
      const live = byClient.get(c.client_id) ?? [];
      const lastTokenAt = live.reduce<string | null>(
        (max, t) => (max === null || t.created_at > max ? t.created_at : max),
        null,
      );
      const scope = live.reduce<string | null>(
        (max, t) => (max === null || t.scope > max ? t.scope : max),
        null,
      );
      return {
        clientId: c.client_id,
        clientName: c.client_name ? String(c.client_name) : null,
        createdAt: c.created_at,
        activeTokens: live.length,
        lastTokenAt,
        scope: scope || null,
      };
    });
}

/**
 * Revoke everything a client holds — tokens and any pending codes.
 *
 * The registration row deliberately survives: it is the record that this
 * client existed, and the next connect re-authorizes without re-registering.
 * The effect is immediate because verifyBearer reads the tokens table on
 * every request; there is no cache to wait out.
 */
export async function revokeClient(clientId: string): Promise<void> {
  const tokens = await table("oauth_tokens");
  const codes = await table("oauth_codes");
  await tokens.delete(`client_id = ${lit(clientId)}`);
  await codes.delete(`client_id = ${lit(clientId)}`);
}
