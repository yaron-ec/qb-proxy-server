import { useState, useEffect, Fragment } from "react";
import { apiCall } from "@/api/railway/client";
import * as railwayOwners from "@/api/railway/owners";
import { CheckCircle, XCircle, Loader2, RefreshCw, Mail, User, AlertTriangle, Pencil, X, Check, GitMerge } from "lucide-react";

const VALID_ROLES = ["admin", "manager", "sales_rep", "office"];

export default function OwnerDirectoryTab({ readOnly } = {}) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall('/api/v1/users', { method: 'GET' }).then(data => {
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
          <div className="overflow-x-auto">
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
          </div>
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

      <ReplyToContactDirectory readOnly={readOnly} />
    </div>
  );
}

// ── Reply-To Contact Directory ──────────────────────────────────────────────
// A SEPARATE table (`owners`, not `users` above) — the one ActivityComposer.jsx's
// resolveOwnerEmail() actually reads to fill "Replies will go to..." on
// CRM-sent email, and the one leads/appointments/deals ownership actually
// points to. Admins see every owner, including deactivated/merged
// duplicates and legacy rows (a read-only audit — GET /api/v1/owners/all),
// with live reference counts, and can edit, deactivate, or safely merge a
// duplicate into a canonical owner. Non-admins keep the original read-only,
// active-only view.
function ReplyToContactDirectory({ readOnly }) {
  const [owners, setOwners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [draftEmail, setDraftEmail] = useState("");
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Merge workflow state — mergingId is the DUPLICATE being consolidated away.
  const [mergingId, setMergingId] = useState(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergePreview, setMergePreview] = useState(null);
  const [mergeLoadingPreview, setMergeLoadingPreview] = useState(false);
  const [mergeSubmitting, setMergeSubmitting] = useState(false);
  const [mergeError, setMergeError] = useState(null);

  const load = () => {
    setLoading(true);
    const call = readOnly ? railwayOwners.list() : railwayOwners.listAll();
    call.then(data => {
      setOwners(data.items || []);
      setLoading(false);
    }).catch(err => {
      console.error('[ReplyToContactDirectory] Error loading owners:', err);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (owner) => {
    setError(null);
    setEditingId(owner.id);
    setDraftEmail(owner.email || "");
    setDraftName(owner.display_name || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setError(null);
  };

  const saveEdit = async (owner) => {
    setSaving(true);
    setError(null);
    try {
      const res = await railwayOwners.update(owner.id, { email: draftEmail.trim(), display_name: draftName.trim() });
      setOwners(prev => prev.map(o => o.id === owner.id ? { ...o, ...(res.owner || { email: draftEmail.trim(), display_name: draftName.trim() }) } : o));
      setEditingId(null);
    } catch (e) {
      setError(e?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const openMerge = (owner) => {
    setMergingId(owner.id);
    setMergeTargetId("");
    setMergePreview(null);
    setMergeError(null);
  };

  const cancelMerge = () => {
    setMergingId(null);
    setMergeTargetId("");
    setMergePreview(null);
    setMergeError(null);
  };

  const chooseTarget = async (targetId) => {
    setMergeTargetId(targetId);
    setMergePreview(null);
    setMergeError(null);
    if (!targetId) return;
    setMergeLoadingPreview(true);
    try {
      const preview = await railwayOwners.mergePreview(mergingId, targetId);
      setMergePreview(preview);
    } catch (e) {
      setMergeError(e?.message || 'Failed to load merge preview.');
    } finally {
      setMergeLoadingPreview(false);
    }
  };

  const confirmMerge = async () => {
    setMergeSubmitting(true);
    setMergeError(null);
    try {
      await railwayOwners.merge(mergeTargetId, mergingId);
      cancelMerge();
      load();
    } catch (e) {
      setMergeError(e?.message || 'Merge failed.');
    } finally {
      setMergeSubmitting(false);
    }
  };

  const activeOwners = owners.filter(o => o.is_active);
  const showAudit = !readOnly; // /all (with reference_counts + inactive rows) is admin-only

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Reply-To Contact Directory</h3>
          <p className="text-xs text-slate-500 mt-1">
            The address each owner's Reply-To resolves to when sending CRM email, and the real ownership record behind Leads, Deals, and Appointments. Independent of the Users table above.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-slate-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading owners...
        </div>
      ) : owners.length === 0 ? (
        <div className="p-8 text-center text-slate-400 text-sm">No active owners found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Display Name</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-slate-500">Reply-To Email</th>
                {showAudit && <th className="text-center px-5 py-2.5 text-xs font-semibold text-slate-500">Status</th>}
                {showAudit && <th className="text-center px-5 py-2.5 text-xs font-semibold text-slate-500">References</th>}
                {!readOnly && <th className="text-right px-5 py-2.5 text-xs font-semibold text-slate-500">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {owners.map((owner) => {
                const mergedIntoOwner = owner.merged_into_owner_id ? owners.find(o => o.id === owner.merged_into_owner_id) : null;
                return (
                <Fragment key={owner.id}>
                <tr className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${!owner.is_active ? 'opacity-60' : ''}`}>
                  {editingId === owner.id ? (
                    <>
                      <td className="px-5 py-2.5">
                        <input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          className="w-full text-xs border border-slate-300 rounded px-2 py-1"
                          placeholder="Display name"
                        />
                      </td>
                      <td className="px-5 py-2.5">
                        <input
                          value={draftEmail}
                          onChange={(e) => setDraftEmail(e.target.value)}
                          className="w-full text-xs font-mono border border-slate-300 rounded px-2 py-1"
                          placeholder="email@ecconstructiongroup.com"
                        />
                        {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
                      </td>
                      {showAudit && <td />}
                      {showAudit && <td />}
                      <td className="px-5 py-2.5 text-right whitespace-nowrap">
                        <button onClick={() => saveEdit(owner)} disabled={saving} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded disabled:opacity-50" title="Save">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={cancelEdit} disabled={saving} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded" title="Cancel">
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-5 py-3 font-medium text-slate-800">{owner.display_name || "—"}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          <span className="text-xs font-mono text-slate-600">{owner.email}</span>
                        </div>
                      </td>
                      {showAudit && (
                        <td className="px-5 py-3 text-center">
                          {owner.is_active ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold"><CheckCircle className="w-3.5 h-3.5" /> Active</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-slate-500 text-xs font-semibold" title={owner.merged_at ? `Merged ${new Date(owner.merged_at).toLocaleDateString()}` : undefined}>
                              <XCircle className="w-3.5 h-3.5" /> {mergedIntoOwner ? `Merged → ${mergedIntoOwner.display_name || mergedIntoOwner.email}` : 'Inactive'}
                            </span>
                          )}
                        </td>
                      )}
                      {showAudit && (
                        <td className="px-5 py-3 text-center text-xs text-slate-500">
                          {owner.reference_counts ? owner.reference_counts.total : '—'}
                        </td>
                      )}
                      {!readOnly && (
                        <td className="px-5 py-3 text-right whitespace-nowrap">
                          {owner.is_active && (
                            <>
                              <button onClick={() => startEdit(owner)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded" title="Edit">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {activeOwners.length > 1 && (
                                <button onClick={() => openMerge(owner)} className="p-1.5 text-slate-400 hover:text-blue-700 hover:bg-blue-50 rounded" title="Merge into another owner">
                                  <GitMerge className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      )}
                    </>
                  )}
                </tr>
                {mergingId === owner.id && (
                  <tr>
                    <td colSpan={showAudit ? 5 : 3} className="px-5 py-4 bg-blue-50 border-b border-blue-100">
                      <div className="max-w-xl">
                        <p className="text-xs font-semibold text-slate-700 mb-2">
                          Merge <span className="font-mono">{owner.display_name || owner.email}</span> into another owner. This deactivates the duplicate and moves every Lead, Appointment, Deal, Task, and Commission it owns to the owner you pick — nothing is deleted.
                        </p>
                        <select
                          value={mergeTargetId}
                          onChange={(e) => chooseTarget(e.target.value)}
                          className="text-xs border border-slate-300 rounded px-2 py-1.5 w-full max-w-sm"
                        >
                          <option value="">Select the canonical owner to keep…</option>
                          {activeOwners.filter(o => o.id !== owner.id).map(o => (
                            <option key={o.id} value={o.id}>{o.display_name || o.email} ({o.email})</option>
                          ))}
                        </select>

                        {mergeLoadingPreview && (
                          <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading preview…</p>
                        )}

                        {mergePreview && !mergeLoadingPreview && (
                          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3">
                            <p className="text-xs font-semibold text-slate-700 mb-1.5">This will move:</p>
                            <ul className="text-xs text-slate-600 space-y-0.5 mb-2">
                              <li>{mergePreview.will_repoint.leads} lead(s)</li>
                              <li>{mergePreview.will_repoint.appointments} appointment(s)</li>
                              <li>{mergePreview.will_repoint.deals} deal(s)</li>
                              <li>{mergePreview.will_repoint.tasks} task(s)</li>
                              <li>{mergePreview.will_repoint.deal_commissions} commission record(s)</li>
                            </ul>
                            <p className="text-[11px] text-slate-400 mb-2">
                              {mergePreview.preserved_historical.lead_submissions + mergePreview.preserved_historical.appointment_events} historical/audit record(s) will keep their original attribution, unchanged.
                            </p>
                            {mergePreview.blocked && (
                              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded p-2 mb-2">
                                <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                                <p className="text-[11px] text-red-700">
                                  Blocked: {mergePreview.appointment_overlap_conflicts.length} appointment(s) would double-book the same time slot. Reschedule or cancel the conflicting appointment first.
                                </p>
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-2">
                              <button
                                onClick={confirmMerge}
                                disabled={mergeSubmitting || mergePreview.blocked}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 disabled:opacity-50"
                              >
                                {mergeSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />}
                                {mergeSubmitting ? 'Merging…' : 'Confirm Merge'}
                              </button>
                              <button onClick={cancelMerge} disabled={mergeSubmitting} className="px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded hover:bg-slate-50">
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {mergeError && <p className="text-[11px] text-red-600 mt-2">{mergeError}</p>}
                        {!mergePreview && !mergeLoadingPreview && (
                          <button onClick={cancelMerge} className="mt-2 text-xs font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}