import React, { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import * as railwayApi from '@/lib/railwayApi';
import { setTokens } from '@/api/railway/client';
import { isExitBuild } from '@/lib/app-params';
import { RAILWAY_API_URL } from '@/lib/apiConfig';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Lock, Mail } from 'lucide-react';

/**
 * Native CRM login page — Railway-owned authentication.
 *
 * Two login paths:
 *   1. "Continue with Google" → Railway /api/v1/auth/google → Google OAuth →
 *      Railway callback → Railway session (primary, SSO)
 *   2. Email + password → Railway /api/v1/auth/login (fallback)
 *
 * After Google OAuth callback, tokens arrive in the URL hash fragment:
 *   /login#access=xxx&refresh=xxx
 * This page detects them, stores them, and enters the CRM.
 *
 * Renders in BOTH the exit build and the Base44 preview when
 * VITE_RAILWAY_AUTH=true (USE_RAILWAY_AUTH in AuthContext).
 */
export default function Login() {
  const { isAuthenticated, checkAppState } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [googleRedirecting, setGoogleRedirecting] = useState(false);

  // ── Handle Google OAuth callback tokens in URL hash ────────────────────
  // After the Railway callback redirects here with #access=xxx&refresh=xxx,
  // extract, store, and enter the CRM.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access=')) return;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const access = params.get('access');
    const refresh = params.get('refresh');
    if (access && refresh) {
      setTokens(access, refresh);
      // Clear the hash so tokens don't linger in the browser URL
      window.history.replaceState({}, document.title, window.location.pathname);
      // Re-run the auth state machine to load the Railway user
      checkAppState().then(() => navigate('/', { replace: true }));
    }
  }, []);

  // Already authenticated (valid Railway session) → straight to the CRM.
  if (isAuthenticated) return <Navigate to="/" replace />;

  const onGoogleLogin = () => {
    setGoogleRedirecting(true);
    // Redirect to the Railway Google OAuth endpoint.
    // Pass the frontend origin so the callback knows where to return.
    const redirect = encodeURIComponent(window.location.origin);
    window.location.href = `${RAILWAY_API_URL}/api/v1/auth/google?redirect=${redirect}`;
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Enter your email and password.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await railwayApi.login(trimmedEmail, password);
      await checkAppState();
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err?.message || 'Invalid email or password.';
      setError(/401|invalid credentials|email or password/i.test(msg)
        ? 'Invalid email or password.'
        : msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-4">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 mb-4 rounded-full bg-amber-100">
            <Lock className="w-7 h-7 text-amber-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">EC Construction Group</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to the CRM</p>
        </div>

        {/* Continue with Google — primary SSO path */}
        <Button
          type="button"
          variant="outline"
          className="w-full mb-4"
          onClick={onGoogleLogin}
          disabled={googleRedirecting || submitting}
        >
          {googleRedirecting ? (
            <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Redirecting to Google…</>
          ) : (
            <>
              <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </>
          )}
        </Button>

        {/* Divider */}
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-slate-400 font-medium">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>

        {/* Email + password — fallback path */}
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-9"
                disabled={submitting || googleRedirecting}
                placeholder="you@ecconstructiongroup.com"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || googleRedirecting}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting || googleRedirecting}>
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}