import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { apiCall } from '@/api/railway/client';
import { setTokens } from '@/api/railway/client';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

/**
 * AcceptInvite — public, unauthenticated activation page (PRODUCTIZATION —
 * Company Provisioning System, multi-company onboarding workflow).
 *
 * Reached from a branded invite email's link
 * (`${frontend_url}/accept-invite?token=...`) sent either by the platform
 * Company Management flow (a brand-new company's very first owner) or by
 * an existing company's own admin inviting an employee
 * (POST /api/v1/auth/invite) — both land here, since both are just a
 * `users` row with no password and a single-use, expiring invite token
 * (lib/authService.js#acceptInvite on the backend).
 *
 * On success, the backend returns a normal session (same shape as
 * POST /login) — the user is signed in immediately, no separate login step.
 */
export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { checkAppState } = useAuth();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!token) { setError('This invite link is missing its token. Ask your admin to resend the invite.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const session = await apiCall('/api/v1/auth/accept-invite', { method: 'POST', body: { token, password } });
      setTokens(session.access, session.refresh);
      setDone(true);
      await checkAppState();
      navigate('/', { replace: true });
    } catch (err) {
      const msg = err?.message || '';
      setError(/invalid_or_expired_token/i.test(msg)
        ? 'This invite link is invalid or has expired. Ask your admin to resend the invite.'
        : (msg || 'Something went wrong. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-4">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
        <div className="flex flex-col items-center mb-6">
          <h1 className="text-xl font-bold text-slate-900">Set Your Password</h1>
          <p className="text-sm text-slate-500 mt-1 text-center">Verify your email and choose a password to activate your account.</p>
        </div>

        {!token && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
            This link is missing its invite token. Ask your admin to resend the invite.
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="password">New Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || done}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm">Confirm Password</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={submitting || done}
              placeholder="Re-enter your password"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <Button type="submit" className="w-full" disabled={submitting || done || !token}>
            {submitting ? (<><Loader2 className="w-4 h-4 animate-spin" /> Activating…</>) : done ? 'Signed in — redirecting…' : 'Activate & Sign In'}
          </Button>
        </form>
      </div>
    </div>
  );
}
