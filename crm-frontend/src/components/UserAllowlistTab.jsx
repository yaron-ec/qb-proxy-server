import { useState, useEffect } from 'react';
import { apiCall } from '@/api/railway/client';
import { Plus, Trash2, X } from 'lucide-react';

export default function UserAllowlistTab() {
  const [allowlist, setAllowlist] = useState([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('sales_rep');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadAllowlist();
  }, []);

  const loadAllowlist = async () => {
    try {
      const data = await apiCall('/api/v1/user-allowlist', { method: 'GET' }).then(r => r.items || []);
      setAllowlist(data);
    } catch (e) {
      console.error('Failed to load allowlist:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    setSaving(true);
    try {
      const entry = await apiCall('/api/v1/user-allowlist', {
        method: 'POST',
        body: {
          email: newEmail.toLowerCase(),
          name: newName.trim() || newEmail.split('@')[0],
          role: newRole,
          enabled: true,
        },
      });
      setAllowlist([...allowlist, entry]);
      setNewEmail('');
      setNewName('');
      setNewRole('sales_rep');
    } catch (e) {
      alert('Error adding user: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this user from allowlist?')) return;
    try {
      await apiCall(`/api/v1/user-allowlist/${id}`, { method: 'DELETE' });
      setAllowlist(allowlist.filter(u => u.id !== id));
    } catch (e) {
      alert('Error removing user: ' + e.message);
    }
  };

  const handleToggle = async (id, enabled) => {
    try {
      const updated = await apiCall(`/api/v1/user-allowlist/${id}`, { method: 'PUT', body: { enabled: !enabled } });
      setAllowlist(allowlist.map(u => u.id === id ? updated : u));
    } catch (e) {
      alert('Error updating user: ' + e.message);
    }
  };

  if (loading) {
    return <div className="p-6 text-slate-500">Loading...</div>;
  }

  return (
    <div className="max-w-4xl">
      {/* Info */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm font-semibold text-blue-900 mb-1">🔐 Access Control Enabled</p>
        <p className="text-xs text-blue-800">Only users in this allowlist can sign in to the application. Users not listed will be denied access.</p>
      </div>

      {/* Add new user */}
      <div className="card-premium p-5 mb-6">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Add authorized user</h3>
        <div className="space-y-3">
          <input
            type="email"
            placeholder="user@example.com"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
          />
          <input
            type="text"
            placeholder="Full name (optional)"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <select
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
            value={newRole}
            onChange={e => setNewRole(e.target.value)}
          >
            <option value="admin">Admin</option>
            <option value="manager">Manager</option>
            <option value="sales_rep">Sales Rep</option>
            <option value="office">Office</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={!newEmail.trim() || saving}
            className="w-full px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" /> Add User
          </button>
        </div>
      </div>

      {/* Allowlist */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Authorized users ({allowlist.length})</h3>
        {allowlist.length === 0 ? (
          <div className="card-premium p-8 text-center text-slate-400 text-sm">No users authorized yet</div>
        ) : (
          allowlist.map(user => (
            <div key={user.id} className="card-premium p-4 flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900">{user.email}</p>
                <p className="text-xs text-slate-500 mt-1">
                  {user.name} • Role: {user.role}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(user.id, user.enabled)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                    user.enabled
                      ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {user.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  onClick={() => handleDelete(user.id)}
                  className="p-1.5 text-slate-400 hover:text-red-600 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}