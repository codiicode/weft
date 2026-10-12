import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Privy access-token verification, mirroring @privy-io/node: ES256 JWTs,
 * issuer "privy.io", audience = the Privy app id, user id (DID) in `sub`.
 * Keys come from the app's JWKS (https://api.privy.io/v1/apps/<appId>/jwks.json)
 * or a verification key pasted from the Privy dashboard.
 *
 * Without PRIVY_APP_ID the API runs in local mode: one implicit user, "local".
 */

export interface AuthUser {
  id: string;
}

export interface Authenticator {
  readonly enabled: boolean;
  readonly appId: string | null;
  verify(token: string): Promise<AuthUser>;
}

export class AuthError extends Error {}

export const LOCAL_USER: AuthUser = { id: "local" };

export function createAuthenticator(opts: {
  appId?: string | null;
  verificationKey?: string | null;
  apiUrl?: string;
  /** Inject a key resolver (tests). */
  keyResolver?: JWTVerifyGetKey | CryptoKey;
}): Authenticator {
  const appId = opts.appId?.trim() || null;
  if (!appId) {
    return {
      enabled: false,
      appId: null,
      async verify() {
        return LOCAL_USER;
      },
    };
  }
  let key: JWTVerifyGetKey | CryptoKey | undefined = opts.keyResolver;
  const getKey = async (): Promise<JWTVerifyGetKey | CryptoKey> => {
    if (key) return key;
    const pem = opts.verificationKey?.trim();
    key = pem
      ? await importSPKI(pem.replace(/\\n/g, "\n"), "ES256")
      : createRemoteJWKSet(new URL(`${opts.apiUrl ?? "https://api.privy.io"}/v1/apps/${appId}/jwks.json`), {
          cacheMaxAge: 60 * 60 * 1000,
          cooldownDuration: 10 * 60 * 1000,
        });
    return key;
  };
  return {
    enabled: true,
    appId,
    async verify(token: string) {
      try {
        const k = await getKey();
        const opts = { algorithms: ["ES256"], issuer: "privy.io", audience: appId };
        const { payload } = typeof k === "function" ? await jwtVerify(token, k, opts) : await jwtVerify(token, k, opts);
        if (!payload.sub) throw new AuthError("token has no subject");
        return { id: payload.sub };
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError(`invalid access token: ${(e as Error).message}`);
      }
    },
  };
}
