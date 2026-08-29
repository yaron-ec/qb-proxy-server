import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { apiCall } from "@/api/railway/client";
import {
  Search, Plus, Pencil, Trash2, X, Check, MoreVertical,
  UserX, UserCheck, Mail, RefreshCw, Shield, Loader2, Users,
  ChevronDown, ChevronUp, CheckCircle2, Circle, ArrowRight
} from "lucide-react";

const ROLES = [
  { value: "admin", label: "Admin", color: "bg-purple-100 text-purple-800" },
  { value: "manager", label: "Manager", color: "bg-blue-100 text-blue-800" },
  { value: "sales_rep", label: "Sales Rep", color: "bg-emerald-100 text-emerald-800" },
  { value: "office", label: "Office", color: "bg-amber-100 text-amber-800" },
  { value: "viewer", label: "Viewer", color: "bg-slate-100 text-slate-600" },
];

const STATUS_CONFIG = {
  active:      { label: "Active",      dot: "bg-emerald-400", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  pending:     { label: "Pending",     dot: "bg-amber-400",   badge: "bg-amber-50 text-amber-700 border-amber-200" },
  deactivated: { label: "Deactivated", dot: "bg-slate-300",   badge: "bg-slate-50 text-slate-500 border-slate-200" },
};

function getInitials(name) {
  if (!name) return "?";
  return name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2);
}

function getRoleInfo(role) {
  return ROLES.find(r => r.value === role) || { label: role || "User", color: "bg-slate-100 text-slate-600" };
}

function getStatus(user) {
  return user.user_status || "active";
}

function fmtDate(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Avatar initials circle
function Avatar({ name, size = "md" }) {
  const colors = [
    "bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-amber-500",
    "bg-red-500", "bg-cyan-500", "bg-indigo-500", "bg-pink-500",
  ];
  const color = colors[(name?.charCodeAt(0) || 0) % colors.length];
  const sz = size === "lg" ? "w-11 h-11 text-sm" : "w-9 h-9 text-xs";
  return (
    <div className={`${sz} ${color} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0`}>
      {getInitials(name)}
    </div>
  );
}

// Confirmation modal
function ConfirmModal({ title, message, confirmLabel = "Confirm", danger = true, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-sm mx-4">
        <div className="px-6 py-5">
          <h3 className="text-sm font-bold text-slate-800 mb-2">{title}</h3>
          <p className="text-sm text-slate-600">{message}</p>
        </div>
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onCancel} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-bold rounded-lg transition-colors ${danger ? "bg-red-500 hover:bg-red-600 text-white" : "bg-orange text-white hover:bg-orange/90"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Edit / Invite modal
function UserModal({ user, onSave, onClose, saving, error }) {
  const isNew = !user?.id;
  const [form, setForm] = useState({
    full_name: user?.full_name || "",
    email: user?.primaryBusinessEmail || user?.email || "",
    role: user?.role || "sales_rep",
    owner_name: user?.owner_name || "",
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-800">{isNew ? "Add New User" : "Edit User"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Full Name</label>
            <input
              type="text"
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              value={form.full_name}
              onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))}
              placeholder="John Smith"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Email Address</label>
            <input
              type="email"
              className={`w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors ${!isNew ? "bg-slate-50 text-slate-500" : ""}`}
              value={form.email}
              onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
              placeholder="user@ecconstructiongroup.com"
              readOnly={!isNew}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Role</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              value={form.role}
              onChange={e => setForm(p => ({ ...p, role: e.target.value }))}
            >
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Contact Owner Name <span className="text-slate-400 font-normal">(how leads are assigned to this user)</span></label>
            <input
              type="text"
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              value={form.owner_name}
              onChange={e => setForm(p => ({ ...p, owner_name: e.target.value }))}
              placeholder="e.g. Yaron, Michelle, David"
            />
          </div>
          {isNew && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-800">
              <strong>Note:</strong> An email invite will be sent to the user with a login link. They will set their own password on first login.
            </div>
          )}
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onClose} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={saving || !form.email.trim()}
            className="bg-orange text-white px-5 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isNew ? <Mail className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
            {saving ? "Saving..." : isNew ? "Send Invite" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuBtn({ icon, label, onClick, color = "text-slate-700" }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold hover:bg-slate-50 transition-colors ${color}`}
    >
      {icon}{label}
    </button>
  );
}

// Portal-based dropdown — never clipped by overflow:hidden containers
function ActionsMenu({ user, onEdit, onDeactivate, onReactivate, onDelete, onResendInvite }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, openUp: false });
  const btnRef = useRef(null);
  const status = getStatus(user);
  const menuHeight = 180; // approx height of menu

  const openMenu = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuHeight + 16;
    setPos({
      top: openUp ? rect.top - menuHeight - 4 : rect.bottom + 4,
      left: Math.min(rect.right - 176, window.innerWidth - 192), // align right, clamp to viewport
      openUp,
    });
    setOpen(true);
  }, []);

  // Close on scroll or resize
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const menu = open && createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
      {/* Menu */}
      <div
        className="fixed z-[9999] bg-white border border-slate-200 rounded-xl shadow-2xl py-1.5 min-w-[176px]"
        style={{ top: pos.top, left: pos.left }}
      >
        <MenuBtn icon={<Pencil className="w-3.5 h-3.5" />} label="Edit User" onClick={() => { setOpen(false); onEdit(); }} />
        <MenuBtn icon={<RefreshCw className="w-3.5 h-3.5" />} label="Reset Password" onClick={() => { setOpen(false); onResendInvite(); }} color="text-blue-600" />
        {status === "deactivated" ? (
          <MenuBtn icon={<UserCheck className="w-3.5 h-3.5" />} label="Activate User" onClick={() => { setOpen(false); onReactivate(); }} color="text-emerald-600" />
        ) : (
          <MenuBtn icon={<UserX className="w-3.5 h-3.5" />} label="Deactivate User" onClick={() => { setOpen(false); onDeactivate(); }} color="text-amber-600" />
        )}
        <div className="border-t border-slate-100 my-1" />
        <MenuBtn icon={<Trash2 className="w-3.5 h-3.5" />} label="Delete User" onClick={() => { setOpen(false); onDelete(); }} color="text-red-500" />
      </div>
    </>,
    document.body
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {menu}
    </>
  );
}

export default function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [bulkEmails, setBulkEmails] = useState("");
  const [bulkRole, setBulkRole] = useState("sales_rep");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type, user }
  const [toast, setToast] = useState(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Use backend function so it works in published app (service role bypasses RLS)
      const data = await apiCall('/api/v1/users', { method: 'GET' }).then(r => r.items || r.users || []);
      setUsers(data);
    } catch (e) {
      console.error("loadUsers error:", e);
    }
    setLoading(false);
  };

  // Filtered + searched users
  const filtered = users.filter(u => {
    const s = getStatus(u);
    const matchStatus = filterStatus === "all" || s === filterStatus;
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (u.full_name || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.primaryBusinessEmail || "").toLowerCase().includes(q) ||
      (u.role || "").toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  const openInvite = () => { setEditingUser(null); setModalError(""); setShowModal(true); };
  const openEdit = (user) => { setEditingUser(user); setModalError(""); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingUser(null); setModalError(""); };

  const handleSave = async (form) => {
    setSaving(true);
    setModalError("");
    try {
      if (!editingUser) {
        // Base44 platform only accepts "user" or "admin" as invite role.
        // We invite as "user" then immediately update to the real custom role.
        const platformRole = (form.role === 'admin') ? 'admin' : 'user';
        await apiCall('/api/v1/auth/invite', { method: 'POST', body: { email: form.email.trim(), role: platformRole } });

        // Small delay so the user record is created before we update it
        await new Promise(r => setTimeout(r, 1500));

        // Reload users to find the newly created record and apply the real role
        const allUsers = await apiCall('/api/v1/users', { method: 'GET' }).then(r => r.items || r.users || []);
        const newUser = allUsers.find(u =>
          (u.email || u.primaryBusinessEmail || '').toLowerCase() === form.email.trim().toLowerCase()
        );
        if (newUser) {
          await apiCall(`/api/v1/users/${newUser.id}`, {
            method: 'PUT',
            body: {
              role: form.role,
              full_name: form.full_name || undefined,
              owner_name: form.owner_name || undefined,
            },
          });
        }

        // Add to allowlist so they pass auth check
        try {
          await apiCall('/api/v1/user-allowlist', {
            method: 'POST',
            body: {
              email: form.email.trim().toLowerCase(),
              name: form.full_name || form.email.split('@')[0],
              role: form.role,
              enabled: true,
            },
          });
        } catch (e) { /* allowlist entry may already exist */ }
        showToast(`Invite sent to ${form.email}`);
      } else {
        // Update existing
        const res = await apiCall(`/api/v1/users/${editingUser.id}`, {
          method: 'PUT',
          body: {
            full_name: form.full_name,
            role: form.role,
            owner_name: form.owner_name,
          },
        }).catch(e => ({ error: e.message }));
        if (res?.error) { setModalError(res.error); setSaving(false); return; }
        showToast("User updated successfully");
      }
      await loadUsers();
      closeModal();
    } catch (e) {
      setModalError(e?.response?.data?.error || e.message || "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (user) => {
    await apiCall(`/api/v1/users/${user.id}`, { method: 'PUT', body: { user_status: "deactivated" } });
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, user_status: "deactivated" } : u));
    showToast(`${user.full_name} deactivated`);
    setConfirm(null);
  };

  const handleReactivate = async (user) => {
    await apiCall(`/api/v1/users/${user.id}`, { method: 'PUT', body: { user_status: "active" } });
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, user_status: "active" } : u));
    showToast(`${user.full_name} reactivated`, "success");
    setConfirm(null);
  };

  const handleDelete = async (user) => {
    try {
      await apiCall(`/api/v1/users/${user.id}`, { method: 'DELETE' });
      setUsers(prev => prev.filter(u => u.id !== user.id));
      showToast(`${user.full_name} deleted`);
    } catch (e) {
      const msg = e?.message || "";
      if (msg.includes("owner of the app")) {
        showToast("Cannot delete the app owner account.", "error");
      } else {
        showToast(msg || "Failed to delete user.", "error");
      }
    }
    setConfirm(null);
  };

  const handleResendInvite = async (user) => {
    const email = user.primaryBusinessEmail || user.email;
    await apiCall('/api/v1/auth/invite', { method: 'POST', body: { email, role: user.role || "sales_rep" } });
    showToast(`Password reset link sent to ${email}`);
  };

  const handleBulkInvite = async () => {
    const emails = bulkEmails.split("\n").map(e => e.trim()).filter(Boolean);
    if (!emails.length) return;
    setBulkSaving(true);
    let success = 0;
    for (const email of emails) {
      try { await apiCall('/api/v1/auth/invite', { method: 'POST', body: { email, role: bulkRole } }); success++; } catch {}
    }
    showToast(`${success}/${emails.length} invites sent`);
    setBulkEmails(""); setShowBulk(false); setBulkSaving(false);
    await loadUsers();
  };

  const counts = {
    all: users.length,
    active: users.filter(u => getStatus(u) === "active").length,
    pending: users.filter(u => getStatus(u) === "pending").length,
    deactivated: users.filter(u => getStatus(u) === "deactivated").length,
  };

  return (
    <div className="max-w-5xl space-y-5">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[70] px-5 py-3 rounded-xl shadow-xl text-sm font-semibold flex items-center gap-2 ${toast.type === "success" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
          {toast.type === "success" ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Team Members</h2>
          <p className="text-sm text-slate-500 mt-0.5">{users.length} user{users.length !== 1 ? "s" : ""} · manage roles, access, and permissions</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowBulk(b => !b)}
            className="flex items-center gap-2 border border-slate-200 text-slate-600 px-4 py-2 text-sm font-semibold rounded-lg hover:bg-slate-50 transition-colors"
          >
            <Users className="w-4 h-4" /> Bulk Import
          </button>
          <button
            onClick={openInvite}
            className="flex items-center gap-2 bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> Invite User
          </button>
        </div>
      </div>

      {/* Bulk import panel */}
      {showBulk && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-bold text-slate-700">Bulk Invite Users</h3>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors resize-none"
            rows={4}
            placeholder="Paste email addresses (one per line)"
            value={bulkEmails}
            onChange={e => setBulkEmails(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <select
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
              value={bulkRole}
              onChange={e => setBulkRole(e.target.value)}
            >
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <button
              onClick={handleBulkInvite}
              disabled={bulkSaving || !bulkEmails.trim()}
              className="bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {bulkSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
              Send {bulkEmails.split("\n").filter(e => e.trim()).length || 0} Invites
            </button>
            <button onClick={() => setShowBulk(false)} className="text-sm text-slate-500 hover:text-slate-700 font-semibold">Cancel</button>
          </div>
        </div>
      )}

      {/* Search + filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by name, email, or role..."
            className="w-full border border-slate-200 rounded-lg pl-9 pr-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5">
          {["all", "active", "pending", "deactivated"].map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors capitalize ${filterStatus === s ? "bg-slate-800 text-white" : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"}`}
            >
              {s === "all" ? `All (${counts.all})` : `${s.charAt(0).toUpperCase() + s.slice(1)} (${counts[s]})`}
            </button>
          ))}
        </div>
        <button onClick={loadUsers} className="p-2.5 border border-slate-200 rounded-lg text-slate-500 hover:bg-slate-50 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Users table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        {/* Table header */}
        <div className="grid grid-cols-[2.5fr_2fr_1.2fr_1fr_1.2fr_auto] gap-4 px-5 py-3 bg-slate-50 border-b border-slate-200 text-xs font-bold uppercase tracking-wide text-slate-500">
          <div>User</div>
          <div>Email</div>
          <div>Role</div>
          <div>Owner</div>
          <div>Status</div>
          <div></div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading users...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Users className="w-10 h-10 mb-3 opacity-30" />
            <div className="text-sm font-semibold">No users found</div>
            {search && <div className="text-xs mt-1">Try a different search term</div>}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filtered.map(user => {
              const status = getStatus(user);
              const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.active;
              const roleInfo = getRoleInfo(user.role);
              const email = user.primaryBusinessEmail || user.email || "—";
              const isDeactivated = status === "deactivated";
              // Check if deactivated for 30+ days
              const deactivatedLong = isDeactivated && (() => {
                const updated = new Date(user.updated_date || user.created_date);
                return (Date.now() - updated.getTime()) > 30 * 24 * 60 * 60 * 1000;
              })();

              return (
                <div
                  key={user.id}
                  className={`grid grid-cols-[2.5fr_2fr_1.2fr_1fr_1.2fr_auto] gap-4 px-5 py-4 items-center hover:bg-slate-50/70 transition-colors ${isDeactivated ? "opacity-60" : ""}`}
                >
                  {/* User */}
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={user.full_name} />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800 truncate">{user.full_name || "Unknown"}</div>
                      <div className="text-xs text-slate-400 truncate">{email}</div>
                    </div>
                  </div>

                  {/* Email */}
                  <div className="text-sm text-slate-600 truncate" title={email}>{email}</div>

                  {/* Role */}
                  <div>
                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${roleInfo.color}`}>
                      {roleInfo.value === "admin" && <Shield className="w-3 h-3" />}
                      {roleInfo.label}
                    </span>
                  </div>

                  {/* Owner */}
                  <div className="text-xs text-slate-600 truncate">{user.owner_name || "—"}</div>

                  {/* Status */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${statusCfg.badge}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`} />
                      {statusCfg.label}
                    </span>
                    {deactivatedLong && (
                      <button
                        onClick={() => setConfirm({ type: "delete", user })}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600 border border-red-200 hover:bg-red-200 transition-colors"
                        title="Deactivated 30+ days — click to delete"
                      >
                        <Trash2 className="w-2.5 h-2.5" /> Delete
                      </button>
                    )}
                  </div>

                  {/* Actions */}
                  <ActionsMenu
                    user={user}
                    onEdit={() => openEdit(user)}
                    onDeactivate={() => setConfirm({ type: "deactivate", user })}
                    onReactivate={() => handleReactivate(user)}
                    onDelete={() => setConfirm({ type: "delete", user })}
                    onResendInvite={() => handleResendInvite(user)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Onboarding Workflow Guide */}
      <OnboardingGuide />

      {/* Role Permissions Matrix */}
      <RolePermissionsMatrix />

      {/* Modals */}
      {showModal && (
        <UserModal
          user={editingUser}
          onSave={handleSave}
          onClose={closeModal}
          saving={saving}
          error={modalError}
        />
      )}

      {confirm?.type === "deactivate" && (
        <ConfirmModal
          title="Deactivate User?"
          message={`${confirm.user.full_name} will be unable to log in until reactivated.`}
          confirmLabel="Deactivate"
          onConfirm={() => handleDeactivate(confirm.user)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {confirm?.type === "delete" && (
        <ConfirmModal
          title="Delete User?"
          message={`This will permanently remove ${confirm.user.full_name} from the system. This cannot be undone.`}
          confirmLabel="Delete Permanently"
          onConfirm={() => handleDelete(confirm.user)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ── Onboarding Guide ─────────────────────────────────────────────────────────
function OnboardingGuide() {
  const [open, setOpen] = useState(false);

  const steps = [
    {
      num: 1,
      title: "Invite the User",
      color: "bg-amber-100 text-amber-700 border-amber-300",
      dot: "bg-amber-500",
      description: "Click the \"Invite User\" button above. Enter their email, full name, and select their role.",
      detail: "An email invite is automatically sent to the user by the platform. The role you select here determines their CRM permissions immediately upon login.",
    },
    {
      num: 2,
      title: "Assign the Correct Role",
      color: "bg-blue-100 text-blue-700 border-blue-300",
      dot: "bg-blue-500",
      description: "Choose the right role in the invite form. This cannot be changed later without editing the user.",
      detail: "Sales Rep → sees only their own leads. Manager → sees all leads + reports. Office → invoices & scheduling. Admin → full access including settings.",
    },
    {
      num: 3,
      title: "User Accepts the Invite",
      color: "bg-purple-100 text-purple-700 border-purple-300",
      dot: "bg-purple-500",
      description: "The user checks their email, clicks the invite link, and sets their password.",
      detail: "Once they complete signup, their status changes from \"Pending\" to \"Active\" in the users list above. They can log in immediately.",
    },
    {
      num: 4,
      title: "User Gets CRM Access",
      color: "bg-emerald-100 text-emerald-700 border-emerald-300",
      dot: "bg-emerald-500",
      description: "The user logs in and sees only the data their role allows — no manual configuration needed.",
      detail: "Role-based permissions are enforced automatically at the database level. A Sales Rep cannot see other reps' leads even if they try to access them directly.",
    },
  ];

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-amber-600" />
          <span className="text-sm font-bold text-slate-800">User Onboarding Workflow</span>
          <span className="text-xs text-slate-500 font-normal">— How to add new users step by step</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="bg-white px-5 py-5">
          <div className="grid md:grid-cols-4 gap-4">
            {steps.map((step, i) => (
              <div key={step.num} className="relative">
                {/* Connector arrow */}
                {i < steps.length - 1 && (
                  <div className="hidden md:flex absolute top-5 -right-2 z-10 items-center">
                    <ArrowRight className="w-4 h-4 text-slate-300" />
                  </div>
                )}
                <div className={`border rounded-xl p-4 h-full ${step.color}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-6 h-6 rounded-full ${step.dot} text-white text-xs font-bold flex items-center justify-center flex-shrink-0`}>
                      {step.num}
                    </span>
                    <span className="text-xs font-bold">{step.title}</span>
                  </div>
                  <p className="text-xs leading-relaxed mb-2">{step.description}</p>
                  <p className="text-[11px] opacity-75 leading-relaxed">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 bg-slate-50 rounded-lg px-4 py-3 border border-slate-200">
            <p className="text-xs font-bold text-slate-700 mb-1">⚠️ Common Reason Users Can't Log In</p>
            <p className="text-xs text-slate-600">
              The user was added to the <strong>Access Control allowlist</strong> but was <strong>never sent a Base44 invite</strong>.
              The allowlist is informational only — it does not grant login access.
              Always use <strong>"Invite User"</strong> above as the single source of truth for granting access.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Role Permissions Matrix ───────────────────────────────────────────────────
function RolePermissionsMatrix() {
  const [open, setOpen] = useState(false);

  const permissions = [
    { feature: "View own leads",             admin: true,  manager: true,  sales_rep: true,  office: false, viewer: true  },
    { feature: "View ALL leads",             admin: true,  manager: true,  sales_rep: false, office: false, viewer: true  },
    { feature: "Create / edit leads",        admin: true,  manager: true,  sales_rep: true,  office: false, viewer: false },
    { feature: "Delete leads",               admin: true,  manager: false, sales_rep: false, office: false, viewer: false },
    { feature: "View deals & revenue",       admin: true,  manager: true,  sales_rep: false, office: true,  viewer: false },
    { feature: "Create invoices",            admin: true,  manager: false, sales_rep: false, office: true,  viewer: false },
    { feature: "Send/view documents (SignNow)", admin: true, manager: false, sales_rep: false, office: true, viewer: false },
    { feature: "View reports & dashboard",   admin: true,  manager: true,  sales_rep: false, office: false, viewer: true  },
    { feature: "Access Settings",            admin: true,  manager: false, sales_rep: false, office: false, viewer: false },
    { feature: "Manage users",               admin: true,  manager: false, sales_rep: false, office: false, viewer: false },
    { feature: "QB / HubSpot sync",          admin: true,  manager: false, sales_rep: false, office: false, viewer: false },
  ];

  const roleColors = {
    admin:     "text-purple-700",
    manager:   "text-blue-700",
    sales_rep: "text-emerald-700",
    office:    "text-amber-700",
    viewer:    "text-slate-600",
  };

  const roleLabels = { admin: "Admin", manager: "Manager", sales_rep: "Sales Rep", office: "Office", viewer: "Viewer" };

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-bold text-slate-800">Role Permissions Matrix</span>
          <span className="text-xs text-slate-500 font-normal">— What each role can access</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-5 py-3 font-bold text-slate-600 w-64">Feature / Permission</th>
                {Object.entries(roleLabels).map(([role, label]) => (
                  <th key={role} className={`px-4 py-3 font-bold text-center ${roleColors[role]}`}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {permissions.map((row, i) => (
                <tr key={i} className="hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-slate-700 font-medium">{row.feature}</td>
                  {["admin", "manager", "sales_rep", "office", "viewer"].map(role => (
                    <td key={role} className="px-4 py-3 text-center">
                      {row[role]
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                        : <Circle className="w-4 h-4 text-slate-200 mx-auto" />
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
            <p className="text-[11px] text-slate-500">
              Permissions are enforced automatically at the database level when a role is assigned.
              No manual configuration is needed — assign the role during invite and access is immediate upon first login.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}