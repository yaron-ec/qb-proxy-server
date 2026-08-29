import React from 'react';
import { useAuth } from '@/lib/AuthContext';
import { Lock, Mail, LogOut } from 'lucide-react';

const UserNotRegisteredError = ({ authError, user }) => {
  const { logout } = useAuth();
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 p-4">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-lg border border-slate-200 p-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 mb-5 rounded-full bg-amber-100">
          <Lock className="w-7 h-7 text-amber-600" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">Account Not Set Up</h1>
        <p className="text-sm text-slate-600 mb-1">
          {user?.email && <span className="font-medium text-slate-800">{user.email}</span>}
        </p>
        <p className="text-sm text-slate-500 mb-6 mt-3">
          Your account has not been set up yet.<br />
          Contact your administrator to create your account.
        </p>
        <div className="bg-slate-50 rounded-xl p-4 mb-6 text-left">
          <p className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5" /> Contact Admin
          </p>
          <p className="text-xs text-slate-500">
            yaron@ecconstructiongroup.com<br />
            michelle@ecconstructiongroup.com
          </p>
        </div>
        <button
          onClick={() => logout()}
          className="flex items-center gap-2 w-full justify-center px-4 py-2.5 border border-slate-200 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
        >
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </div>
    </div>
  );
};

export default UserNotRegisteredError;