"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { api, setTokenGetter } from "./api";

/**
 * Sign-in for the app. With NEXT_PUBLIC_PRIVY_APP_ID set, users sign in with
 * Privy (external EVM/Solana wallet, email or Google; embedded wallets are
 * created for users without one). Without it the app runs in local mode: a
 * single implicit user, which matches the API's local mode.
 */

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() || "";
const CLIENT_ID = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim() || undefined;

export interface AuthState {
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  /** Short label for the signed-in user: wallet address or email. */
  label: string | null;
  wallets: { address: string; chain: "ethereum" | "solana" | "other"; embedded: boolean }[];
  login: () => void;
  logout: () => Promise<void>;
}

const LOCAL: AuthState = {
  enabled: false,
  ready: true,
  authenticated: true,
  label: "Local mode",
  wallets: [],
  login: () => {},
  logout: async () => {},
};

const AuthContext = createContext<AuthState>(LOCAL);

export const useAuth = () => useContext(AuthContext);

/**
 * For actions that need an account: returns `true` when the user may proceed,
 * otherwise opens the sign-in modal and returns `false`.
 */
export function useRequireAuth() {
  const auth = useAuth();
  return useCallback(() => {
    if (!auth.enabled || auth.authenticated) return true;
    auth.login();
    return false;
  }, [auth]);
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const reported = useRef<string | null>(null);

  // Every API request carries the Privy access token while signed in.
  useEffect(() => {
    setTokenGetter(authenticated ? () => getAccessToken() : null);
    return () => setTokenGetter(null);
  }, [authenticated, getAccessToken]);

  const wallets = useMemo<AuthState["wallets"]>(() => {
    const out: AuthState["wallets"] = [];
    for (const a of user?.linkedAccounts ?? []) {
      if (a.type !== "wallet") continue;
      const w = a as unknown as { address: string; chainType?: string; walletClientType?: string };
      out.push({
        address: w.address,
        chain: w.chainType === "ethereum" ? "ethereum" : w.chainType === "solana" ? "solana" : "other",
        embedded: w.walletClientType === "privy",
      });
    }
    return out;
  }, [user]);

  // Tell the API which wallets the user has (for display; the API authorizes by token only).
  useEffect(() => {
    if (!authenticated || !user) return;
    const key = `${user.id}:${wallets.map((w) => w.address).join(",")}`;
    if (reported.current === key) return;
    reported.current = key;
    api.reportProfile({ wallets: wallets.map((w) => w.address), displayName: user.email?.address ?? null }).catch(() => {});
  }, [authenticated, user, wallets]);

  const value = useMemo<AuthState>(
    () => ({
      enabled: true,
      ready,
      authenticated,
      label: user ? (wallets[0] ? shortAddress(wallets[0].address) : user.email?.address ?? "Signed in") : null,
      wallets,
      login,
      logout,
    }),
    [ready, authenticated, user, wallets, login, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!APP_ID) return <AuthContext.Provider value={LOCAL}>{children}</AuthContext.Provider>;
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  return (
    <PrivyProvider
      appId={APP_ID}
      clientId={CLIENT_ID}
      config={{
        loginMethods: ["wallet", "email", "google"],
        appearance: {
          theme: dark ? "dark" : "light",
          accentColor: dark ? "#EDEDEB" : "#121214",
          landingHeader: "Sign in to Weft",
          loginMessage: "Free on paper. Nothing trades without your approval.",
          showWalletLoginFirst: true,
          walletChainType: "ethereum-and-solana",
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          solana: { createOnLogin: "users-without-wallets" },
        },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  );
}
