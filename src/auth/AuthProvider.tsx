import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  AuthUser,
  getAuthStatus,
  login as loginRequest,
  logout as logoutRequest,
  setupAdmin,
} from "../data/auth";
import { setSessionToken } from "../data/api";

type AuthContextValue = {
  loading: boolean;
  setupRequired: boolean;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<void>;
  setup: (input: { username: string; displayName: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      setSetupRequired(status.setupRequired);
      setUser(status.user);
    } catch (error) {
      console.error("Authentication status error:", error);
      setSetupRequired(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unauthorized = () => {
      setSessionToken(null);
      setUser(null);
    };
    window.addEventListener("dbrepairs:unauthorized", unauthorized);
    return () => window.removeEventListener("dbrepairs:unauthorized", unauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const account = await loginRequest(username, password);
    setUser(account);
    setSetupRequired(false);
  }, []);

  const setup = useCallback(async (input: { username: string; displayName: string; password: string }) => {
    const account = await setupAdmin(input);
    setUser(account);
    setSetupRequired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ loading, setupRequired, user, login, setup, logout, refresh }),
    [loading, setupRequired, user, login, setup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
