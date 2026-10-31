import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type GuanlanPrincipal = {
  /** Cloud Auth subject; the Cloud Account that owns the consumer. */
  accountId: string;
  /** Stable consumer identity minted into the credential, never supplied by a tool argument. */
  consumerId: string;
  scopes: string[];
  /** Seconds since epoch, as in the JWT `exp` claim. */
  expiresAt: number;
  issuer: string;
  audience: string;
};

/**
 * Narrow resource-server verifier contract. Cloud Auth owns issuance; Guanlan
 * only verifies an already-issued access token and derives the principal.
 */
export interface GuanlanTokenVerifier {
  verifyAccessToken(token: string): Promise<GuanlanPrincipal>;
}

export type CloudAuthVerifierOptions = {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  consumerClaim: string;
  /** Test/integration injection point; production uses the configured remote JWKS. */
  keySet?: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
};

const invalidToken = (): OAuthError =>
  new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");

const tokenScopes = (payload: Record<string, unknown>): string[] => {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((scope): scope is string => typeof scope === "string");
  }
  if (typeof payload.scope === "string") {
    return payload.scope.split(/\s+/).filter(Boolean);
  }
  return [];
};

/**
 * The deployed verifier: Cloud Auth public JWKS, exact issuer/audience binding,
 * a non-empty subject and a token-bound consumer identity. Anything else is an
 * opaque 401; no fallback to a test fixture or an unconfigured local trust.
 */
export function createCloudAuthVerifier(options: CloudAuthVerifierOptions): GuanlanTokenVerifier {
  const keySet = options.keySet ?? createRemoteJWKSet(options.jwksUrl);
  return {
    async verifyAccessToken(token: string): Promise<GuanlanPrincipal> {
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, keySet, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: [
            "RS256", "RS384", "RS512",
            "ES256", "ES384", "ES512",
            "EdDSA",
            "PS256", "PS384", "PS512",
          ],
          clockTolerance: options.clockToleranceSeconds ?? 5,
          requiredClaims: ["iss", "aud", "exp", "sub"],
        });
        payload = verified.payload as Record<string, unknown>;
      } catch {
        throw invalidToken();
      }

      const accountId = typeof payload.sub === "string" ? payload.sub : "";
      const consumerId = typeof payload[options.consumerClaim] === "string"
        ? payload[options.consumerClaim] as string
        : "";
      const expiresAt = typeof payload.exp === "number" ? payload.exp : NaN;
      if (!accountId || !consumerId || !Number.isFinite(expiresAt)) throw invalidToken();

      return {
        accountId,
        consumerId,
        scopes: tokenScopes(payload),
        expiresAt,
        issuer: options.issuer,
        audience: options.audience,
      };
    },
  };
}

export type FixtureTokenTable = Record<string, GuanlanPrincipal>;

/**
 * Deterministic, test-only verifier. It is imported only by test worker entries
 * so the deployed module cannot select it through an environment value.
 */
export function createFixtureVerifier(
  tokens: FixtureTokenTable,
  expected: { issuer: string; audience: string },
): GuanlanTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<GuanlanPrincipal> {
      const principal = tokens[token];
      if (!principal) throw invalidToken();
      if (principal.issuer !== expected.issuer || principal.audience !== expected.audience) {
        throw invalidToken();
      }
      if (!principal.accountId || !principal.consumerId) throw invalidToken();
      return { ...principal, scopes: [...principal.scopes] };
    },
  };
}

/** Adapter from the Guanlan principal to the SDK's auth pass-through shape. */
export function authInfoFromPrincipal(token: string, principal: GuanlanPrincipal): AuthInfo {
  return {
    token,
    clientId: principal.consumerId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource: new URL(principal.audience),
    extra: {
      accountId: principal.accountId,
      consumerId: principal.consumerId,
      issuer: principal.issuer,
      audience: principal.audience,
    },
  };
}

/** Reads only verifier-derived identity; tool arguments never supply these values. */
export function principalFromAuthInfo(authInfo: AuthInfo | undefined): GuanlanPrincipal {
  const extra = authInfo?.extra;
  const accountId = extra?.accountId;
  const consumerId = extra?.consumerId;
  const issuer = extra?.issuer;
  const audience = extra?.audience;
  if (
    !authInfo ||
    typeof accountId !== "string" ||
    typeof consumerId !== "string" ||
    typeof issuer !== "string" ||
    typeof audience !== "string" ||
    !Array.isArray(authInfo.scopes) ||
    typeof authInfo.expiresAt !== "number"
  ) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid_token");
  }
  return {
    accountId,
    consumerId,
    scopes: [...authInfo.scopes],
    expiresAt: authInfo.expiresAt,
    issuer,
    audience,
  };
}
