import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import * as railwayApi from '@/lib/railwayApi';
import { isExitBuild } from '@/lib/app-params';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Lock, Mail } from 'lucide-react';

/**
 * Native CRM login page (Base44 Exit — Stage 1).
 *
 * Authenticates directly against the Railway API:
 *   POST /api/v1/auth/login  →  { access, refresh, user }
 *   GET  /api/v1/auth/me     →  { user }
 *
 * No Base44 dependency. Tokens are stored by the Railway client
 * (src/api/railway/client.js) in localStorage. On success the auth context is
 * re-checked and the user is redirected to the CRM.
 *
 * This page only renders in the exit build. In the Base44 build it redirects
 * to "/" (Base44 provides its own hosted login).
 */
export default function Login() {
  const { isAuthenticated, checkAppState } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Safety: this page only exists for the exit build.
  if (!isExitBuild) return <Navigate to="/" replace />;
  // Already authenticated (valid Railway session) → straight to the CRM.
  if (isAuthenticated) return <Navigate to="/" replace />;

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
      // 1. Railway login → stores access + refresh tokens (localStorage).
      await railwayApi.login(trimmedEmail, password);
      // 2. Re-run the auth state machine so the context holds the Railway user.
      await checkAppState();
      // 3. Enter the CRM.
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
                disabled={submitting}
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
              disabled={submitting}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
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