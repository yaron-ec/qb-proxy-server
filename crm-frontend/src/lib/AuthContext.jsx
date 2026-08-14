import React, { createContext, useState, useContext, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { appParams, isExitBuild } from '@/lib/app-params';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';
import * as railwayApi from '@/lib/railwayApi';

// R1A temporary flag: when true, the auth identity comes from Railway
// (via the migrate bridge + /api/v1/auth/me). When false (default), the
// existing Base44 auth path is unchanged. This flag is removed once auth
// is validated as 100% Railway.
const USE_RAILWAY_AUTH = import.meta.env.VITE_RAILWAY_AUTH === 'true';

const AuthContext = createContext();

// Wraps any promise with a timeout. Rejects with a clear message if exceeded.
function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// Detect Safari private mode / blocked localStorage (iOS PWA safe check)
function isLocalStorageAvailable() {
  try {
    const key = '__ls_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState(null);

  // ── Explicit Railway session state machine ────────────────────────────────
  // Railway-bound flows (emailTransport FLOW_OWNERSHIP === 'railway') require
  // railway_auth_state === 'railway_authenticated'. Base44-only flows are
  // unaffected and never block on this state. There is NO silent best-effort
  // mount migration: provisioning is explicit via ensureRailwaySession(), and
  // failures surface a clear state the UI can show.
  //   railway_auth_initializing — provisioning in flight
  //   railway_authenticated      — Railway JWT active
  //   railway_auth_failed        — bridge rejected the token / role mismatch
  //   railway_auth_unavailable  — Railway not deployed/reachable (no VITE URL)
  //   railway_logged_out        — no session, not attempted
  const [railwayAuthState, setRailwayAuthState] = useState('railway_logged_out');
  const [railwayAuthError, setRailwayAuthError] = useState(null);
  const [railwayUser, setRailwayUser] = useState(null);

  useEffect(() => {
    checkAppState();
  }, []);

  // Provision a Railway session for the authenticated CRM user. Ties the
  // Railway identity to the current user by VERIFIED email + role (server-side
  // token exchange at /api/v1/auth/migrate — the browser never supplies email
  // or role; Railway derives them from the verified Base44 token). Idempotent.
  // Only meaningful when a Railway flow is enabled; today all flows are Base44
  // so this is a no-op until cutover.
  const ensureRailwaySession = async () => {
    if (railwayAuthState === 'railway_authenticated') return railwayAuthState;
    if (!isAuthenticated || !user || !appParams.token) return railwayAuthState;
    if (!import.meta.env.VITE_RAILWAY_API_URL && !import.meta.env.VITE_QB_PROXY_URL) {
      setRailwayAuthState('railway_auth_unavailable');
      return 'railway_auth_unavailable';
    }
    setRailwayAuthState('railway_auth_initializing');
    setRailwayAuthError(null);
    try {
      const data = await railwayApi.migrateFromBase44(appParams.token);
      setRailwayUser(data.user || null);
      setRailwayAuthState('railway_authenticated');
      return 'railway_authenticated';
    } catch (e) {
      const msg = e?.message || String(e);
      setRailwayAuthError(msg);
      // Network/unreachable => unavailable; 401/403 => failed. Never fall back
      // to a privileged session.
      setRailwayAuthState(/fetch|network|Failed to fetch|NetworkError|ECONNREFUSED|503/i.test(msg)
        ? 'railway_auth_unavailable' : 'railway_auth_failed');
      return railwayAuthState;
    }
  };

  const clearRailwaySession = () => {
    try { railwayApi.clearTokens(); } catch (_) {}
    setRailwayUser(null);
    setRailwayAuthError(null);
    setRailwayAuthState('railway_logged_out');
  };

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setIsLoadingAuth(true);
      setAuthError(null);

      // Safari private mode blocks localStorage — token will always be null, causing an infinite loop.
      // Detect this early and route straight to login instead of hanging.
      if (!isLocalStorageAvailable()) {
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
        setAuthChecked(true);
        setAuthError({
          type: 'auth_required',
          message: 'Sign-in requires cookies/storage. Please disable Private Browsing and try again.',
        });
        return;
      }

      // ── Exit build: Railway-only auth path (no Base44 token / settings) ───────
      // No Base44 access token, no Base44 public-settings fetch, no base44.auth.
      // If a Railway session exists, validate it; otherwise surface auth_required
      // so the App gate routes to the native /login page.
      if (isExitBuild) {
        setIsLoadingPublicSettings(false);
        if (!railwayApi.isLoggedIn()) {
          setIsLoadingAuth(false);
          setIsAuthenticated(false);
          setAuthChecked(true);
          setAuthError({ type: 'auth_required', message: 'You must be logged in to access this application' });
          return;
        }
        await checkUserAuth();
        return;
      }

      // If there's no token at all, skip both network calls — go straight to login.
      if (!appParams.token) {
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        setAuthChecked(true);
        setAuthError({ type: 'auth_required', message: 'You must be logged in to access this application' });
        return;
      }

      const appClient = createAxiosClient({
        baseURL: `/api/apps/public`,
        headers: { 'X-App-Id': appParams.appId },
        token: appParams.token,
        interceptResponses: true,
      });

      // Public settings fetch — 8s timeout
      let publicSettings = null;
      try {
        publicSettings = await withTimeout(
          appClient.get(`/prod/public-settings/by-id/${appParams.appId}`),
          8000,
          'Public settings'
        );
        setAppPublicSettings(publicSettings);
      } catch (settingsError) {
        console.warn('[Auth] Public settings failed:', settingsError.message);
        // Non-fatal — continue to auth check even if settings times out
      }
      setIsLoadingPublicSettings(false);

      await checkUserAuth();
    } catch (error) {
      console.error('[Auth] checkAppState unexpected error:', error);
      setAuthError({ type: 'network_error', message: error.message || 'Failed to load app. Please check your connection.' });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    }
  };

  const ADMIN_EMAILS = ['yaron@ecconstructiongroup.com', 'michelle@ecconstructiongroup.com'];

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);

      // auth.me() — 10s timeout. On iOS after sleep/network switch this can hang indefinitely.
      // R1A: when USE_RAILWAY_AUTH, provision a Railway session via the migrate bridge
      // then read the user from Railway /api/v1/auth/me. Otherwise use Base44.
      const currentUser = (USE_RAILWAY_AUTH || isExitBuild)
        ? await withTimeout((async () => {
            // Exit build has no Base44 token to migrate — skip the bridge and
            // read the Railway user directly from /api/v1/auth/me.
            if (!isExitBuild) await ensureRailwaySession();
            const r = await railwayApi.me();
            return r.user;
          })(), 10000, 'railway auth.me()')
        : await withTimeout(base44.auth.me(), 10000, 'auth.me()');

      if (ADMIN_EMAILS.includes(currentUser.email?.toLowerCase())) {
        setUser(currentUser);
        setIsAuthenticated(true);
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }

      if (currentUser.role) {
        setUser(currentUser);
        setIsAuthenticated(true);
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }

      // User exists but has no role
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setUser(currentUser);
      setAuthError({
        type: 'user_not_authorized',
        message: 'Your account has not been set up yet. Contact admin to create your account.',
        userEmail: currentUser.email,
        hasPendingRequest: false,
      });
    } catch (error) {
      console.error('[Auth] checkUserAuth failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);

      if (error.status === 401 || error.status === 403) {
        setAuthError({ type: 'auth_required', message: 'Session expired. Please sign in again.' });
      } else {
        // Timeout or network error — show retry instead of infinite spinner
        setAuthError({
          type: 'network_error',
          message: error.message || 'Could not reach the server. Check your connection and retry.',
        });
      }
    }
  };

  const refreshUser = async () => {
    try {
      const currentUser = (USE_RAILWAY_AUTH || isExitBuild)
        ? (await railwayApi.me()).user
        : await base44.auth.me();
      setUser(currentUser);
      return currentUser;
    } catch (error) {
      console.error('User refresh failed:', error);
      throw error;
    }
  };

  const logout = async (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    // R1A: when USE_RAILWAY_AUTH, revoke the Railway session first.
    // The Base44 logout still runs to clear the Base44 session (login still
    // goes through the Base44-provided page until a native Railway login is built).
    if (USE_RAILWAY_AUTH || isExitBuild) {
      try { await railwayApi.logout(); } catch (_) { /* best-effort */ }
    }
    // Clear the Railway identity + refresh tokens on CRM logout / user switch.
    clearRailwaySession();

    // Exit build: no Base44 session to clear — just go to the native login page.
    if (isExitBuild) {
      if (shouldRedirect) window.location.href = '/login';
      return;
    }

    if (shouldRedirect) {
      // Use the SDK's logout method which handles token cleanup and redirect
      base44.auth.logout(window.location.href);
    } else {
      // Just remove the token without redirect
      base44.auth.logout();
    }
  };

  const navigateToLogin = () => {
    // Exit build: route to the native login page (no Base44 hosted login).
    if (isExitBuild) { window.location.href = '/login'; return; }
    // Use the SDK's redirectToLogin method
    base44.auth.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
      refreshUser,
      railwayAuthState,
      railwayAuthError,
      railwayUser,
      ensureRailwaySession,
      clearRailwaySession,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};