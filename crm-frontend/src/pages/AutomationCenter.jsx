import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Plus, Zap, CheckCircle, AlertCircle, Clock, TrendingUp, MoreVertical, Pause, Play, Trash2, Edit } from "lucide-react";
import { SPINNER, statusBadgeClass } from "@/lib/design-system";

const TRIGGER_LABELS = {
  lead_created: "Lead Created",
  lead_assigned: "Lead Assigned",
  lead_stale: "Lead Stale (14+ days)",
  follow_up_overdue: "Follow-up Overdue",
  deal_created: "Deal Created",
  deal_stalled: "Deal Stalled (21+ days)",
  estimate_missing: "Estimate Missing",
  contract_missing: "Contract Missing",
  contract_sent: "Contract Sent",
  contract_viewed: "Contract Viewed",
  contract_signed: "Contract Signed",
  contract_expired: "Contract Expired",
  invoice_created: "Invoice Created",
  invoice_overdue: "Invoice Overdue",
  payment_received: "Payment Received",
  scheduled: "Scheduled"
};

const ACTION_LABELS = {
  send_email: "Send Email",
  create_task: "Create Task",
  create_invoice: "Create Invoice",
  update_deal_status: "Update Deal Status",
  create_follow_up: "Create Follow-up",
  notify_rep: "Notify Rep",
  notify_manager: "Notify Manager",
  create_calendar_event: "Create Calendar Event",
  send_document: "Send Document"
};

const CATEGORY_COLORS = {
  lead: "bg-blue-50 border-blue-200 text-blue-700",
  deal: "bg-purple-50 border-purple-200 text-purple-700",
  contract: "bg-amber-50 border-amber-200 text-amber-700",
  invoice: "bg-emerald-50 border-emerald-200 text-emerald-700"
};

export default function AutomationCenter() {
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [showBuilder, setShowBuilder] = useState(false);
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    paused: 0,
    failed: 0,
    successRate: 0
  });

  useEffect(() => {
    loadAutomations();
  }, []);

  const loadAutomations = async () => {
    try {
      const automationList = await apiCall('/api/v1/automations?sort=-updated_date&limit=1000', { method: 'GET' }).then(r => r.items || []);
      setAutomations(automationList);

      const activeCount = automationList.filter(a => a.status === "active").length;
      const pausedCount = automationList.filter(a => a.status === "paused").length;
      const failedCount = automationList.filter(a => a.status === "failed").length;

      const successCount = automationList.reduce((sum, a) => sum + (a.success_count || 0), 0);
      const totalRuns = automationList.reduce((sum, a) => sum + (a.run_count || 0), 0);
      const successRate = totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0;

      setStats({
        total: automationList.length,
        active: activeCount,
        paused: pausedCount,
        failed: failedCount,
        successRate
      });

      setLoading(false);
    } catch (e) {
      console.error("Error loading automations:", e);
      setLoading(false);
    }
  };

  const filteredAutomations = automations.filter(a => {
    if (activeTab === "all") return true;
    if (activeTab === "active") return a.status === "active";
    if (activeTab === "paused") return a.status === "paused";
    if (activeTab === "failed") return a.status === "failed";
    if (activeTab === "draft") return a.status === "draft";
    return true;
  });

  const toggleAutomation = async (automation) => {
    const newStatus = automation.status === "active" ? "paused" : "active";
    const updated = await apiCall(`/api/v1/automations/${automation.id}`, { method: 'PUT', body: { status: newStatus } });
    setAutomations(prev => prev.map(a => a.id === automation.id ? updated : a));
  };

  const deleteAutomation = async (automationId) => {
    if (confirm("Delete this automation?")) {
      await apiCall(`/api/v1/automations/${automationId}`, { method: 'DELETE' });
      setAutomations(prev => prev.filter(a => a.id !== automationId));
    }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><div className={SPINNER} /></div>;

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'max(env(safe-area-inset-top), 1.5rem)' }}>
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Automation Center</h1>
            <p className="text-sm text-muted-foreground mt-1">Build, monitor, and manage automated workflows</p>
          </div>
          <button
            onClick={() => setShowBuilder(!showBuilder)}
            className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors active:scale-95"
          >
            <Plus className="w-4 h-4" />
            New Automation
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <StatCard icon={Zap} label="Total" value={stats.total} color="slate" />
          <StatCard icon={CheckCircle} label="Active" value={stats.active} color="green" />
          <StatCard icon={Pause} label="Paused" value={stats.paused} color="yellow" />
          <StatCard icon={AlertCircle} label="Failed" value={stats.failed} color="red" />
          <StatCard icon={TrendingUp} label="Success Rate" value={`${stats.successRate}%`} color="blue" />
        </div>

        {/* Builder */}
        {showBuilder && (
          <AutomationBuilder onCreated={() => { loadAutomations(); setShowBuilder(false); }} />
        )}

        {/* Tabs */}
        <div className="flex gap-2 border-b border-slate-200">
          {[
            { id: "all", label: "All Automations" },
            { id: "active", label: `Active (${stats.active})` },
            { id: "paused", label: `Paused (${stats.paused})` },
            { id: "draft", label: "Draft" },
            { id: "failed", label: `Failed (${stats.failed})` }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-amber-600 text-amber-700"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Automations List */}
        <div className="space-y-3">
          {filteredAutomations.length === 0 ? (
            <div className="text-center py-12">
              <Zap className="w-8 h-8 text-slate-200 mx-auto mb-3" />
              <p className="text-sm text-slate-400">No automations in this view</p>
            </div>
          ) : (
            filteredAutomations.map(automation => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                onToggle={() => toggleAutomation(automation)}
                onDelete={() => deleteAutomation(automation.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }) {
  const colors = {
    slate: "bg-slate-50 text-slate-600 border-slate-200",
    green: "bg-green-50 text-green-600 border-green-200",
    yellow: "bg-yellow-50 text-yellow-600 border-yellow-200",
    red: "bg-red-50 text-red-600 border-red-200",
    blue: "bg-blue-50 text-blue-600 border-blue-200"
  };
  return (
    <div className={`${colors[color]} border rounded-lg p-4`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide opacity-75">{label}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
        </div>
        <Icon className="w-8 h-8 opacity-25" />
      </div>
    </div>
  );
}

function AutomationCard({ automation, onToggle, onDelete }) {
  const isActive = automation.status === "active";
  const lastRunDate = automation.last_run_at ? new Date(automation.last_run_at).toLocaleDateString() : "—";
  const nextRunDate = automation.next_run_at ? new Date(automation.next_run_at).toLocaleDateString() : "—";

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4">
        {/* Left: Details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-base font-semibold text-slate-900">{automation.name}</h3>
            <span className={`text-xs font-bold px-2 py-1 rounded-full border ${CATEGORY_COLORS[automation.category]}`}>
              {automation.category.charAt(0).toUpperCase() + automation.category.slice(1)}
            </span>
            <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${
              automation.status === "active" ? "bg-green-100 text-green-700" :
              automation.status === "paused" ? "bg-yellow-100 text-yellow-700" :
              automation.status === "failed" ? "bg-red-100 text-red-700" :
              "bg-slate-100 text-slate-700"
            }`}>
              {automation.status.charAt(0).toUpperCase() + automation.status.slice(1)}
            </span>
          </div>

          {automation.description && (
            <p className="text-xs text-slate-600 mb-3">{automation.description}</p>
          )}

          {/* Trigger → Action */}
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-slate-500">IF</span>
              <span className="font-semibold text-slate-700">{TRIGGER_LABELS[automation.trigger?.type] || automation.trigger?.type}</span>
            </div>
            <div className="text-slate-300">→</div>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-slate-500">THEN</span>
              <span className="font-semibold text-slate-700">{ACTION_LABELS[automation.action?.type] || automation.action?.type}</span>
            </div>
          </div>

          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>Last: {lastRunDate}</span>
            </div>
            <div className="flex items-center gap-1">
              <TrendingUp className="w-3 h-3" />
              <span>Runs: {automation.run_count || 0}</span>
            </div>
            <div className="flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              <span>Success: {automation.success_count || 0}</span>
            </div>
            {automation.failure_count > 0 && (
              <div className="flex items-center gap-1 text-red-600">
                <AlertCircle className="w-3 h-3" />
                <span>Failed: {automation.failure_count}</span>
              </div>
            )}
          </div>

          {automation.last_run_error && (
            <p className="text-[11px] text-red-600 mt-2 bg-red-50 px-2 py-1 rounded">
              {automation.last_run_error}
            </p>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onToggle}
            className={`p-2 rounded-lg transition-colors ${
              isActive
                ? "bg-green-50 text-green-600 hover:bg-green-100"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            title={isActive ? "Pause" : "Resume"}
          >
            {isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={() => onDelete(automation.id)}
            className="p-2 rounded-lg bg-slate-100 text-slate-600 hover:bg-red-100 hover:text-red-600 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AutomationBuilder({ onCreated }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("lead");
  const [triggerType, setTriggerType] = useState("lead_created");
  const [actionType, setActionType] = useState("send_email");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const newAutomation = await apiCall('/api/v1/automations', {
      method: 'POST',
      body: {
        name,
        category,
        status: "draft",
        trigger: { type: triggerType },
        action: { type: actionType },
        enabled: false,
        run_count: 0,
        success_count: 0,
        failure_count: 0
      },
    });
    setSaving(false);
    onCreated();
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
      <h3 className="text-base font-bold text-slate-900">Create Automation</h3>
      
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Name</label>
          <input
            type="text"
            placeholder="e.g., Send invoice when contract signed"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Category</label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="lead">Lead</option>
            <option value="deal">Deal</option>
            <option value="contract">Contract</option>
            <option value="invoice">Invoice</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Trigger: IF</label>
          <select
            value={triggerType}
            onChange={e => setTriggerType(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Action: THEN</label>
          <select
            value={actionType}
            onChange={e => setActionType(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            {Object.entries(ACTION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <button
          onClick={() => onCreated()}
          className="px-4 py-2 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Create"}
        </button>
      </div>
    </div>
  );
}