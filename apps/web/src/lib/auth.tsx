import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { PermissionCode } from '@cps/shared';
import { api, refreshSession, setAccessToken, setSessionExpiredHandler } from './api';
import type { Me } from './types';

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  me: Me | undefined;
  login: (login: string, password: string) => Promise<{ mustChangePassword: boolean }>;
  logout: () => Promise<void>;
  can: (code: PermissionCode) => boolean;
  reloadMe: () => Promise<unknown>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<'checking' | 'none' | 'active'>('checking');

  // Restore a session from the httpOnly refresh cookie on page load.
  useEffect(() => {
    void refreshSession().then((ok) => setSession(ok ? 'active' : 'none'));
    setSessionExpiredHandler(() => {
      setAccessToken(null);
      qc.clear();
      setSession('none');
    });
  }, [qc]);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/me'),
    enabled: session === 'active',
    staleTime: 60_000,
  });

  const login = useCallback(
    async (login: string, password: string) => {
      const r = await api.post<{ accessToken: string; mustChangePassword: boolean }>('/auth/login', { login, password });
      setAccessToken(r.accessToken);
      qc.clear();
      setSession('active');
      return { mustChangePassword: r.mustChangePassword };
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAccessToken(null);
      qc.clear();
      setSession('none');
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const me = meQuery.data;
    const perms = new Set(me?.permissions ?? []);
    return {
      status: session === 'checking' || (session === 'active' && meQuery.isPending) ? 'loading' : session === 'active' && me ? 'signedIn' : 'signedOut',
      me,
      login,
      logout,
      // UI convenience only — the API enforces every permission itself.
      can: (code) => perms.has('*') || perms.has(code),
      reloadMe: () => meQuery.refetch(),
    };
  }, [session, meQuery, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
