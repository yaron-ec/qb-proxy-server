import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { CheckCircle, XCircle, Loader2, RefreshCw, Mail, User, AlertTriangle } from "lucide-react";

const VALID_ROLES = ["admin", "manager", "sales_rep", "office"];

export default function OwnerDirectoryTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall('/api/v1/auth/users', { method: 'GET' }).then(data => {
      setUsers(data.items || data || []);
      setLoading(false);
    }).catch(err => {
      console.error('[OwnerDirectory] Error loading users:', err);
      setLoading(false);
    });
  }, []);

  // Build directory from Users table
  const directory = users.map(u => {
    const hasValidRole = VALID_ROLES.includes(u.role);
    const isActive = u.user_status !== "deactivated";
    const canReceiveLeads = hasValidRole && isActive;
    return {
      name: u.full_name,
      email: u.email,
      role: u.role,
      status: isActive ? "Active" : "Inactive",
      canReceiveLeads: canReceiveLeads ? "Yes" : "No",
      reason: !hasValidRole ? "Invalid role" : !isActive ? "Deactivated" : null,
    };
  }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const activeUsers = directory.filter(d => d.status === "Active").length;
  const canReceiveCount = directory.filter(d => d.canReceiveLeads === "Yes").length;

  return (
    <div className="max-w-5xl space-y-6">
      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-xs font-semibold text-blue-800 mb-1">📋 Auto-Synced from Users Table</p>
        <p className="text-xs text-blue-700">
          This directory is automatically updated whenever you add, edit, or deactivate users. No manual maintenance needed.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-lg border border-slate-200 p-4 text-center">
          <div className="text-2xl font-bold text-slate-800">{directory.length}</div>
          <div className="text-xs text-slate-500 mt-1">Total Users</div>
        </div>
        <div className="bg-emerald-50 rounded-lg border border-emerald-200 p-4 text-center">
          <div className="text-2xl font-bold text-emerald-600">{activeUsers}</div>
          <div className="text-xs text-slate-500 mt-1">Active</div>
        </div>
        <div className="bg-amber-50 rounded-lg border border-amber-200 p-4 text-center">
          <div className="text-2xl font-bold text-amber-600">{canReceiveCount}</div>
          <div className="text-xs text-slate-500 mt-1">Can Receive Leads</div>
        </div>
      </div>

      {/* Users table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">Active Leads Owners (Auto-Synced)</h3>
          <p className="text-xs text-slate-500 mt-1">These users appear in the Assigned Owner dropdown and can receive lead assignments</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading users...
          </div>
        ) : directory.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            No users found. Add users in the Users tab first.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Full Name</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Email</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Role</th>
                <th className="text-center px-5 py-2.5 text-xs font-semibold text-slate-500">Status</th>
                <th className="text-center px-5 py-2.5 text-xs font-semibold text-slate-500">Can Receive Leads</th>
              </tr>
            </thead>
            <tbody>
              {directory.map((user) => (
                <tr key={user.email} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-bold text-white">{(user.name || "?")[0]?.toUpperCase()}</span>
                      </div>
                      <span className="font-medium text-slate-800">{user.name || "—"}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className="text-xs font-mono text-slate-600">{user.email}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-1 rounded">{user.role}</span>
                  </td>
                  <td className="px-5 py-3 text-center">
                    {user.status === "Active" ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold">
                        <CheckCircle className="w-3.5 h-3.5" /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-slate-500 text-xs font-semibold">
                        <XCircle className="w-3.5 h-3.5" /> Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-center">
                    {user.canReceiveLeads === "Yes" ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold">
                        <CheckCircle className="w-3.5 h-3.5" /> Yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-500 text-xs font-semibold" title={user.reason}>
                        <XCircle className="w-3.5 h-3.5" /> No
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Info section */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <h3 className="text-xs font-bold text-amber-900 mb-2">ℹ️ How "Can Receive Leads" Works</h3>
        <ul className="text-xs text-amber-800 space-y-1">
          <li>✅ <strong>Yes:</strong> User has Admin, Manager, Sales Rep, or Office role AND is Active</li>
          <li>❌ <strong>No:</strong> User is Inactive or has an invalid role (e.g., Viewer)</li>
          <li>📌 Only "Yes" users appear in the Assigned Owner dropdown on the capture form</li>
          <li>📌 If a user is missing, check their Status and Role above</li>
        </ul>
      </div>
    </div>
  );
}