import React, { createContext, useState, useContext, useEffect } from 'react';
import { base44 } from '@/api/base44Client'; // eslint-disable-line no-unused-vars
import * as railwayApi from '@/lib/railwayApi';
import { isApiConfigured } from '@/lib/apiConfig';

/**
 * AuthContext — Railway-only authentication.
 *
 * The base44 import is required by the platform but is NOT used for auth.
 * Railway JWT (access + refresh) is the sole auth layer.
 *
 *   - checkAppState: if no Railway session → auth_required → /login
 *   - checkUserAuth: railwayApi.me() → user + role
 *   - logout: revoke Railway session → /login
 *   - navigateToLogin: → /login
 *
 * Yaron + Michelle remain admins (enforced server-side via user_allowlist).
 * Role/ownership behavior is preserved (Railway JWT carries role + owner_id).
 */
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

  // ── Railway session state (kept for backward-compat with consumers) ────────
  //   railway_authenticated — Railway JWT active
  //   railway_auth_failed   — JWT invalid/expired
  //   railway_logged_out    — no session, not attempted
  const [railwayAuthState, setRailwayAuthState] = useState('railway_logged_out');
  const [railwayAuthError, setRailwayAuthError] = useState(null);
  const [railwayUser, setRailwayUser] = useState(null);

  useEffect(() => {
    checkAppState();
  }, []);

  // Kept for backward-compat with consumers that reference clearRailwaySession.
  const clearRailwaySession = () => {
    try { railwayApi.clearTokens(); } catch (_) {}
    setRailwayUser(null);
    setRailwayAuthError(null);
    setRailwayAuthState('railway_logged_out');
  };

  // Kept for backward-compat with consumers that reference ensureRailwaySession.
  // The migration bridge has been removed — this is now a no-op that returns
  // the current state. New auth is via /login (Google SSO or email/password).
  const ensureRailwaySession = async () => {
    if (railwayApi.isLoggedIn()) {
      setRailwayAuthState('railway_authenticated');
      return 'railway_authenticated';
    }
    return 'railway_logged_out';
  };

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setIsLoadingAuth(true);
      setAuthError(null);

      // Safari private mode blocks localStorage — tokens can never persist.
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

      // ── Railway auth — the sole auth path ────────────────────────────────
      // No Base44 token, no migration bridge. If no Railway session exists,
      // surface auth_required so the App gate routes to /login.
      setIsLoadingPublicSettings(false);

      if (!isApiConfigured()) {
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        setAuthChecked(true);
        setAuthError({
          type: 'network_error',
          message: 'API not configured. Contact support.',
        });
        return;
      }

      if (!railwayApi.isLoggedIn()) {
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        setAuthChecked(true);
        setAuthError({ type: 'auth_required', message: 'You must be logged in to access this application' });
        return;
      }

      await checkUserAuth();
    } catch (error) {
      console.error('[Auth] checkAppState unexpected error:', error);
      setAuthError({ type: 'network_error', message: error.message || 'Failed to load app. Please check your connection.' });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    }
  };

  const checkUserAuth = async () => {
    try {
      setIsLoadingAuth(true);

      // Railway /api/v1/auth/me — validates the JWT and returns the user.
      // 10s timeout: on iOS after sleep/network switch this can hang.
      //
      // CANONICAL AUTHORIZATION SOURCE: the role returned by /me is read from
      // the Railway users table by the backend (getUserById). There is NO
      // ADMIN_EMAILS bypass — the database role is the single source of truth.
      // This eliminates the auth split-brain where the frontend treated a
      // user as admin via email while the backend rejected them via JWT role.
      const currentUser = await withTimeout(
        (async () => {
          const r = await railwayApi.me();
          setRailwayAuthState('railway_authenticated');
          setRailwayUser(r.user || null);
          return r.user;
        })(),
        10000,
        'auth.me()'
      );

      if (!currentUser) {
        setIsLoadingAuth(false);
        setIsAuthenticated(false);
        setAuthChecked(true);
        setAuthError({ type: 'auth_required', message: 'Session expired. Please sign in again.' });
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
      setRailwayAuthState('railway_auth_failed');
      setRailwayAuthError(error.message);

      if (error.status === 401 || error.status === 403) {
        setAuthError({ type: 'auth_required', message: 'Session expired. Please sign in again.' });
      } else {
        setAuthError({
          type: 'network_error',
          message: error.message || 'Could not reach the server. Check your connection and retry.',
        });
      }
    }
  };

  const refreshUser = async () => {
    try {
      const currentUser = (await railwayApi.me()).user;
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
    try { await railwayApi.logout(); } catch (_) { /* best-effort */ }
    clearRailwaySession();

    if (shouldRedirect) {
      window.location.href = '/login';
    }
  };

  const navigateToLogin = () => {
    window.location.href = '/login';
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