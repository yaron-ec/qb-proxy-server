import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { apiCall } from "@/api/railway/client";
import {
  ArrowLeft, Phone, Mail, Calendar, ClipboardList, MoreHorizontal,
  ChevronDown, ChevronRight, Plus, Pencil, Trash2, Save, X, Star, AlertTriangle, Check
} from "lucide-react";
import MeetingsPanel from "../components/MeetingsPanel";
import DealsPanel from "../components/DealsPanel";
import AttachmentsPanel from "../components/AttachmentsPanel";
import EmailPanel from "../components/EmailPanel";
import QBStatusPanel from "../components/QBStatusPanel";
import HandoffEstimatesPanel from "../components/HandoffEstimatesPanel";

const STATUSES = ["New","Appointment scheduled","Answered, no appointment set","No answer","Proposal Sent","No show","DNQ","Sold","Lost"];

const DEFAULT_PROJECT_TYPES = [
  "Kitchen remodel", "Bathroom remodel", "ADU / garage conversion", "Addition",
  "Full-home remodel", "Exterior / hardscape", "Commercial tenant improvement", "Windows", "Other"
];

const STATUS_COLOR = {
  "New": "bg-blue-100 text-blue-700",
  "Appointment scheduled": "bg-emerald-100 text-emerald-700",
  "Answered, no appointment set": "bg-orange-100 text-orange-700",
  "No answer": "bg-slate-100 text-slate-600",
  "Proposal Sent": "bg-amber-100 text-amber-700",
  "No show": "bg-red-100 text-red-500",
  "DNQ": "bg-slate-100 text-slate-500",
  "Sold": "bg-emerald-100 text-emerald-800 font-bold",
  "Lost": "bg-red-100 text-red-700",
};

function fmt(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [activeActivityTab, setActiveActivityTab] = useState("all");
  const [noteText, setNoteText] = useState("");
  const [activities, setActivities] = useState([]);
  const [addingNote, setAddingNote] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState({});
  const [duplicates, setDuplicates] = useState([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [showMeetingModal, setShowMeetingModal] = useState(false);
  const [projectTypes, setProjectTypes] = useState(DEFAULT_PROJECT_TYPES);
  const [contactOwners, setContactOwners] = useState([]);
  const [leadSources, setLeadSources] = useState([]);

  const [tasks, setTasks] = useState([]);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", notes: "", due_date: "", due_time: "" });
  const [savingTask, setSavingTask] = useState(false);

  const [showCallForm, setShowCallForm] = useState(false);
  const [callForm, setCallForm] = useState({ call_date: "", call_time: "", call_notes: "" });
  const [savingCall, setSavingCall] = useState(false);

  const loadTasks = () => {
    apiCall('/api/v1/tasks?lead_id=' + id, { method: 'GET' }).then(r => setTasks(Array.isArray(r) ? r : (r?.items || [])));
  };

  useEffect(() => {
    apiCall('/api/v1/tasks?lead_id=' + id, { method: 'GET' }).then(r => setTasks(Array.isArray(r) ? r : (r?.items || [])));
    apiCall('/api/v1/activities?lead_id=' + id, { method: 'GET' }).then(res => { const hubspotActivities = Array.isArray(res) ? res : (res?.items || []);
      const acts = hubspotActivities.map(a => ({
        id: a.id,
        type: a.type,
        text: a.content,
        date: a.timestamp,
        author: a.author,
        source: a.source,
        metadata: a.metadata,
      }));
      setActivities(acts);
    });
    apiCall(`/api/v1/leads/${id}`, { method: 'GET' }).then(data => {
      setLead(data);
      setForm(data);
      setLoading(false);
      checkDuplicates(id);
    });
    apiCall('/api/v1/settings?key=app_lists', { method: 'GET' }).then(res => { const results = Array.isArray(res) ? res : (res?.items || []);
      if (results[0]?.value?.projectTypes?.length) {
        setProjectTypes(results[0].value.projectTypes);
      }
      if (results[0]?.value?.contactOwners?.length) {
        setContactOwners(results[0].value.contactOwners);
      }
      if (results[0]?.value?.sources?.length) {
        setLeadSources(results[0].value.sources);
      }
    });
  }, [id]);

  const checkDuplicates = async (leadId) => {
    setCheckingDuplicates(true);
    try {
      const res = await apiCall(`/api/v1/leads/${id}`, { method: 'GET' }).catch(() => ({}));
      setDuplicates(res.data.duplicates || []);
    } catch (error) {
      console.error('Error checking duplicates:', error);
    }
    setCheckingDuplicates(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveState("saving");
    const updated = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: form });
    setLead(updated);
    setSaving(false);
    setSaveState("saved");
    setTimeout(() => { setSaveState("idle"); setEditing(false); }, 1200);
  };

  const remove = async () => {
    if (confirm("Delete this lead?")) {
      await apiCall(`/api/v1/leads/${id}`, { method: 'DELETE' });
      navigate("/leads");
    }
  };

  const addNote = () => {
    if (!noteText.trim()) return;
    const newNote = {
      id: `note-${Date.now()}`,
      type: "note",
      text: noteText,
      date: new Date().toISOString(),
      author: lead.assigned_rep || "Rep",
    };
    setActivities(prev => [newNote, ...prev]);
    setNoteText("");
    setAddingNote(false);
    // Save note to lead
    apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { notes: noteText } });
  };

  const toggleSection = (key) => setLeftCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-muted border-t-orange rounded-full animate-spin" />
    </div>
  );

  if (!lead) return <div className="p-8">Lead not found.</div>;

  const f = (key) => form[key] ?? "";
  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const addTask = async () => {
    if (!taskForm.title.trim()) return;
    setSavingTask(true);
    await apiCall('/api/v1/tasks', { method: 'POST', body: { ...taskForm, lead_id: id, completed: false } });
    setTaskForm({ title: "", notes: "", due_date: "", due_time: "" });
    setShowTaskForm(false);
    loadTasks();
    setSavingTask(false);
  };

  const toggleTask = async (task) => {
    await apiCall(`/api/v1/tasks/${task.id}`, { method: 'PUT', body: { completed: !task.completed } });
    loadTasks();
  };

  const deleteTask = async (taskId) => {
    await apiCall(`/api/v1/tasks/${taskId}`, { method: 'DELETE' });
    loadTasks();
  };

  const logCall = async () => {
    if (!callForm.call_date) return;
    setSavingCall(true);
    const timestamp = callForm.call_time 
      ? `${callForm.call_date}T${callForm.call_time}:00Z`
      : `${callForm.call_date}T12:00:00Z`;
    
    await apiCall('/api/v1/activities', {
      method: 'POST',
      body: {
        lead_id: id,
        type: 'call',
        timestamp,
        content: callForm.call_notes || '(Call logged)',
        author: lead.assigned_rep || 'Rep',
        source: 'manual',
      },
    });
    setCallForm({ call_date: "", call_time: "", call_notes: "" });
    setShowCallForm(false);
    
    // Reload activities
    apiCall('/api/v1/activities?lead_id=' + id, { method: 'GET' }).then(res => { const hubspotActivities = Array.isArray(res) ? res : (res?.items || []);
      const acts = hubspotActivities.map(a => ({
        id: a.id,
        type: a.type,
        text: a.content,
        date: a.timestamp,
        author: a.author,
        source: a.source,
        metadata: a.metadata,
      }));
      setActivities(acts);
    });
    setSavingCall(false);
  };



  // Merge all activity types into one unified sorted list
  const allActivitiesUnified = [
    ...activities,
    ...tasks.map(t => ({
      id: `task-${t.id}`,
      type: "task",
      text: t.title + (t.notes ? ` — ${t.notes}` : ""),
      date: t.due_date ? (t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date) : t.created_date,
      author: t.assigned_to || lead?.assigned_rep || "Rep",
      task: t,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const filteredActivities = allActivitiesUnified.filter(a => {
    if (activeActivityTab === "all") return true;
    if (activeActivityTab === "notes") return a.type === "note" || a.type === "created";
    if (activeActivityTab === "emails") return a.type === "email";
    if (activeActivityTab === "calls") return a.type === "call";
    if (activeActivityTab === "tasks") return a.type === "task";
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-[#f5f8fa] overflow-hidden">
      {/* Top Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <Link to="/leads" className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          Contacts
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-xs text-slate-400">Actions ▾</span>
      </div>

      {/* 3-column layout */}
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT SIDEBAR - Contact Info */}
        <div className="w-64 flex-shrink-0 bg-white border-r border-slate-200 overflow-y-auto">
          {/* Contact Header */}
          <div className="p-5 border-b border-slate-100">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-slate-600">
                  {(lead.first_name?.[0] || "?")}{(lead.last_name?.[0] || "")}
                </span>
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-800 leading-tight">
                  {lead.first_name} {lead.last_name}
                </h2>
                {lead.email && (
                  <a href={`mailto:${lead.email}`} className="text-[11px] text-blue-600 hover:underline truncate block max-w-[130px]">
                    {lead.email}
                  </a>
                )}
                {lead.duplicate_merged && (
                  <div className="mt-1 inline-flex items-center gap-1 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    <span className="text-[9px] font-bold text-amber-700 uppercase tracking-wide">
                      🔁 Duplicate merged
                    </span>
                    {lead.last_merge_date && (
                      <span className="text-[9px] text-amber-600">
                        · {new Date(lead.last_merge_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Action icons */}
            <div className="flex items-center justify-around mt-3 pt-3 border-t border-slate-100">
              <ActionIcon icon={<Pencil className="w-3.5 h-3.5" />} label="Note" onClick={() => setAddingNote(true)} />
              <ActionIcon icon={<Mail className="w-3.5 h-3.5" />} label="Email" href={`https://mail.google.com/mail/?view=cm&fs=1&to=${lead.email}`} target="_blank" />
              <ActionIcon icon={<Phone className="w-3.5 h-3.5" />} label="Call" href={`https://wa.me/${lead.phone?.replace(/\D/g, '')}`} target="_blank" />
              <ActionIcon icon={<ClipboardList className="w-3.5 h-3.5" />} label="Task" onClick={() => setActiveActivityTab("tasks")} />
              <ActionIcon icon={<Calendar className="w-3.5 h-3.5" />} label="Meeting" onClick={() => setActiveActivityTab("meetings")} />
              <ActionIcon icon={<MoreHorizontal className="w-3.5 h-3.5" />} label="More" />
            </div>
          </div>

          {/* Google Sync Status */}
          <GoogleSyncStatus lead={lead} onResync={async (type) => {
            const fn = type === 'contact' ? 'realtimeSyncGoogleContact' : 'realtimeSyncGoogleCalendar';
            await apiCall(`/api/v1/leads/${id}/sync`, { method: 'POST', body: { function: fn } }).catch(() => {});
            const updated = await apiCall(`/api/v1/leads/${id}`, { method: 'GET' });
            setLead(updated); setForm(updated);
          }} />

          {/* About Section */}
          <LeftSection title="About this contact" collapsed={leftCollapsed["about"]} onToggle={() => toggleSection("about")}>
            <InfoRow label="Date" value={fmt(lead.created_date)} />
            <InfoRow label="Email" value={lead.email} link={`mailto:${lead.email}`} />
            <InfoRow label="Phone Number" value={lead.phone} link={`tel:${lead.phone}`} />

            <SidebarField label="Job Type">
              <select className="sidebar-input"
                value={lead.project_type || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { project_type: e.target.value } }); setLead(u); setForm(u); }}>
                <option value="">— Select —</option>
                {projectTypes.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </SidebarField>

            <SidebarField label="Lead Status">
              <select className="sidebar-input"
                value={lead.status || "New"}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { status: e.target.value } }); setLead(u); setForm(u); }}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </SidebarField>

            {/* QuickBooks Sync Eligibility Badge */}
            {lead.status === "Sold" && !lead.qb_sync_ineligible && (
              <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 mt-1">
                <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wide">💼 QuickBooks Sync Eligible</span>
              </div>
            )}
            {lead.qb_sync_ineligible && (
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">⚠️ No longer eligible for QB sync</span>
              </div>
            )}

            <SidebarField label="Appointment Date">
              <input type="date" className="sidebar-input"
                value={lead.appointment_date || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { appointment_date: e.target.value } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="Appointment Time">
              <select className="sidebar-input"
                value={lead.appointment_time || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { appointment_time: e.target.value } }); setLead(u); setForm(u); }}>
                <option value="">— Select —</option>
                {Array.from({ length: 23 }, (_, i) => {
                  const hour = Math.floor(i / 2) + 8;
                  const min = i % 2 === 0 ? "00" : "30";
                  if (hour > 19) return null;
                  const h12 = hour > 12 ? hour - 12 : hour;
                  const ampm = hour >= 12 ? "PM" : "AM";
                  const label = `${h12}:${min} ${ampm}`;
                  const val = `${String(hour).padStart(2,"0")}:${min}`;
                  return <option key={val} value={val}>{label}</option>;
                })}
              </select>
            </SidebarField>

            <SidebarField label="Street Address">
              <SidebarTextInput value={lead.property_address || ""} onSave={async (v) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { property_address: v } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="City">
              <SidebarTextInput value={lead.city || ""} onSave={async (v) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { city: v } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="Bid ($)">
              <CurrencyInput value={lead.estimated_value} onSave={async (v) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { estimated_value: v } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="Follow Up Date">
              <input type="date" className="sidebar-input"
                value={lead.follow_up_date || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { follow_up_date: e.target.value } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="Close Date">
              <input type="date" className="sidebar-input"
                value={lead.close_date || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { close_date: e.target.value } }); setLead(u); setForm(u); }} />
            </SidebarField>

            <SidebarField label="Contact Owner">
              <select className="sidebar-input"
                value={lead.assigned_rep || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { assigned_rep: e.target.value } }); setLead(u); setForm(u); }}>
                <option value="">— Select —</option>
                {contactOwners.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </SidebarField>

            <SidebarField label="Lead Source">
              <select className="sidebar-input"
                value={lead.source || ""}
                onChange={async (e) => { const u = await apiCall(`/api/v1/leads/${id}`, { method: 'PUT', body: { source: e.target.value } }); setLead(u); setForm(u); }}>
                <option value="">— Select —</option>
                {leadSources.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </SidebarField>

          </LeftSection>


        </div>

        {/* CENTER - Activities */}
        <div className="flex-1 overflow-y-auto">
          {/* Edit mode banner */}
          {editing && (
            <div className="bg-blue-50 border-b border-blue-200 px-6 py-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-blue-800">Editing lead details</span>
              <div className="flex gap-2">
                <button onClick={save} disabled={saving}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all duration-300 ${saveState === "saved" ? "bg-emerald-500 text-white" : "bg-orange text-white hover:bg-orange/90 disabled:opacity-50"}`}>
                  {saveState === "saved" ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
                  {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved!" : "Save"}
                </button>
                <button onClick={() => { setEditing(false); setForm(lead); }}
                  className="flex items-center gap-1.5 border border-slate-300 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-slate-50 transition-colors">
                  <X className="w-3 h-3" />Cancel
                </button>
              </div>
            </div>
          )}

          {/* Activity tabs */}
          <div className="bg-white border-b border-slate-200 px-6">
            <div className="flex gap-0">
              <button className="px-4 py-3 text-xs font-semibold border-b-2 border-orange text-orange">
                Activities
              </button>
            </div>
          </div>

          <div className="p-6">
            {/* Activity filter tabs */}
            <div className="bg-white rounded border border-slate-200 overflow-hidden">
              <div className="flex items-center border-b border-slate-100 px-4 pt-3 pb-0 gap-0">
                {[
                  { id: "all", label: "All activities" },
                  { id: "notes", label: "Notes" },
                  { id: "emails", label: "Emails" },
                  { id: "calls", label: "Calls" },
                  { id: "tasks", label: "Tasks" },
                  { id: "meetings", label: "Meetings" },
                ].map(tab => (
                  <button key={tab.id} onClick={() => setActiveActivityTab(tab.id)}
                    className={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors mr-1 ${
                      activeActivityTab === tab.id
                        ? "border-orange text-orange"
                        : "border-transparent text-slate-500 hover:text-slate-700"
                    }`}>
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Add Note area - only show for non-Meetings and non-Calls tabs */}
              {addingNote && activeActivityTab !== "meetings" && activeActivityTab !== "calls" ? (
                <div className="p-4 border-b border-slate-100">
                  <textarea
                    className="w-full border border-slate-200 rounded p-3 text-sm text-slate-700 resize-none focus:outline-none focus:border-blue-400 transition-colors"
                    rows={3}
                    placeholder="Add a note..."
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    autoFocus
                  />
                  <div className="flex gap-2 mt-2">
                    <button onClick={addNote} className="bg-orange text-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded hover:bg-orange/90 transition-colors">
                      Save note
                    </button>
                    <button onClick={() => { setAddingNote(false); setNoteText(""); }}
                      className="border border-slate-300 px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded hover:bg-slate-50 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : activeActivityTab !== "meetings" && activeActivityTab !== "calls" && activeActivityTab !== "tasks" ? (
                <div className="p-3 border-b border-slate-100">
                  <button onClick={() => setAddingNote(true)}
                    className="w-full text-left text-xs text-slate-400 border border-dashed border-slate-200 rounded px-3 py-2 hover:border-slate-300 hover:text-slate-500 transition-colors flex items-center gap-2">
                    <Plus className="w-3 h-3" />
                    Add a note...
                  </button>
                </div>
              ) : null}

              {/* Activity list or Meetings form */}
              {activeActivityTab === "meetings" ? (
                <MeetingsPanel lead={lead} />
              ) : activeActivityTab === "all" ? (
                filteredActivities.length === 0 ? (
                  <div className="py-12 text-center text-slate-400 text-sm">No activities yet</div>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {filteredActivities.map(act => (
                      <ActivityItem key={act.id} activity={act} />
                    ))}
                  </div>
                )
              ) : activeActivityTab === "notes" ? (
                filteredActivities.length === 0 ? (
                  <div className="py-12 text-center text-slate-400 text-sm">No notes yet</div>
                ) : (
                  <div className="divide-y divide-slate-50">
                    {filteredActivities.map(act => (
                      <ActivityItem key={act.id} activity={act} />
                    ))}
                  </div>
                )
              ) : activeActivityTab === "calls" ? (
               <div className="p-4 space-y-3">
                 <button
                   onClick={() => setShowCallForm(v => !v)}
                   className="w-full flex items-center justify-center gap-2 bg-orange text-white px-3 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors"
                 >
                   <Plus className="w-3.5 h-3.5" /> Log Call
                 </button>

                 {showCallForm && (
                   <div className="border border-slate-200 rounded p-3 space-y-2 bg-slate-50">
                     <div className="grid grid-cols-2 gap-2">
                       <div>
                         <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Date</label>
                         <input type="date" className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                           value={callForm.call_date} onChange={e => setCallForm(p => ({ ...p, call_date: e.target.value }))} />
                       </div>
                       <div>
                         <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Time</label>
                         <input type="time" className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                           value={callForm.call_time} onChange={e => setCallForm(p => ({ ...p, call_time: e.target.value }))} />
                       </div>
                     </div>
                     <textarea
                       placeholder="What happened in this call? (optional)"
                       rows={3}
                       className="w-full border border-slate-200 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400"
                       value={callForm.call_notes}
                       onChange={e => setCallForm(p => ({ ...p, call_notes: e.target.value }))}
                     />
                     <div className="flex gap-2">
                       <button onClick={logCall} disabled={savingCall || !callForm.call_date}
                         className="bg-orange text-white px-3 py-1.5 text-xs font-bold rounded hover:bg-orange/90 transition-colors disabled:opacity-50">
                         {savingCall ? "Saving..." : "Log Call"}
                       </button>
                       <button onClick={() => setShowCallForm(false)}
                         className="border border-slate-300 px-3 py-1.5 text-xs font-bold rounded hover:bg-slate-100 transition-colors">
                         Cancel
                       </button>
                     </div>
                   </div>
                 )}

                 {lead?.phone ? (
                   <a href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"
                     className="w-full flex items-center justify-center gap-2 bg-green-500 text-white px-3 py-2 text-xs font-bold rounded hover:bg-green-600 transition-colors">
                     <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.272-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.67-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421-7.403h-.004a9.87 9.87 0 00-9.746 9.748c0 2.646.735 5.236 2.131 7.496L2.02 21.5l7.996-2.097a9.86 9.86 0 007.456 3.187h.005c5.38 0 9.747-4.367 9.747-9.748 0-2.604-.675-5.05-1.955-7.12C19.098 6.723 16.659 5.09 13.85 5.09"/></svg>
                     Call on WhatsApp
                   </a>
                 ) : (
                   <div className="p-4 text-center text-slate-400 text-xs">No phone number available</div>
                 )}
               </div>
              ) : activeActivityTab === "tasks" ? (
                <div className="p-4 space-y-3">
                  <button
                    onClick={() => setShowTaskForm(v => !v)}
                    className="w-full flex items-center justify-center gap-2 bg-orange text-white px-3 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Task
                  </button>

                  {showTaskForm && (
                    <div className="border border-slate-200 rounded p-3 space-y-2 bg-slate-50">
                      <input
                        type="text"
                        placeholder="Task title *"
                        className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
                        value={taskForm.title}
                        onChange={e => setTaskForm(p => ({ ...p, title: e.target.value }))}
                        autoFocus
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Due Date</label>
                          <input type="date" className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                            value={taskForm.due_date} onChange={e => setTaskForm(p => ({ ...p, due_date: e.target.value }))} />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Time</label>
                          <input type="time" className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                            value={taskForm.due_time} onChange={e => setTaskForm(p => ({ ...p, due_time: e.target.value }))} />
                        </div>
                      </div>
                      <textarea
                        placeholder="Notes (optional)"
                        rows={2}
                        className="w-full border border-slate-200 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-400"
                        value={taskForm.notes}
                        onChange={e => setTaskForm(p => ({ ...p, notes: e.target.value }))}
                      />
                      <div className="flex gap-2">
                        <button onClick={addTask} disabled={savingTask}
                          className="bg-orange text-white px-3 py-1.5 text-xs font-bold rounded hover:bg-orange/90 transition-colors disabled:opacity-50">
                          {savingTask ? "Saving..." : "Save Task"}
                        </button>
                        <button onClick={() => setShowTaskForm(false)}
                          className="border border-slate-300 px-3 py-1.5 text-xs font-bold rounded hover:bg-slate-100 transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {tasks.length === 0 && !showTaskForm && (
                    <div className="py-8 text-center text-slate-400 text-xs">No tasks yet</div>
                  )}

                  <div className="space-y-2">
                    {tasks.sort((a,b) => (a.completed ? 1 : -1)).map(task => (
                      <div key={task.id} className={`border rounded p-3 flex items-start gap-3 transition-colors ${
                        task.completed ? "border-slate-100 bg-slate-50" : "border-slate-200 bg-white"
                      }`}>
                        <input
                          type="checkbox"
                          checked={!!task.completed}
                          onChange={() => toggleTask(task)}
                          className="w-4 h-4 mt-0.5 accent-orange flex-shrink-0 cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-semibold ${task.completed ? "line-through text-slate-400" : "text-slate-800"}`}>
                            {task.title}
                          </div>
                          {(task.due_date || task.due_time) && (
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {task.due_date && new Date(task.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              {task.due_time && ` at ${task.due_time}`}
                            </div>
                          )}
                          {task.notes && <div className="text-xs text-slate-500 mt-1">{task.notes}</div>}
                        </div>
                        <button onClick={() => deleteTask(task.id)} className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0">
                          <X className="w-3.5 h-3.5 text-orange hover:text-red-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : activeActivityTab === "emails" ? (
                <EmailPanel lead={lead} />
              ) : null}
               </div>

               {/* Edit Form (shown below activities when editing) */}
            {editing && (
              <div className="mt-6 space-y-4">
                <div className="bg-white rounded border border-slate-200 p-5">
                  <h3 className="text-xs font-bold tracking-widest uppercase text-slate-500 mb-4">Contact Information</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <EditField label="First Name" value={f("first_name")} onChange={v => set("first_name", v)} />
                    <EditField label="Last Name" value={f("last_name")} onChange={v => set("last_name", v)} />
                    <EditField label="Email" value={f("email")} onChange={v => set("email", v)} />
                    <EditField label="Phone" value={f("phone")} onChange={v => set("phone", v)} />
                    <div className="col-span-2">
                      <EditField label="Property Address" value={f("property_address")} onChange={v => set("property_address", v)} />
                    </div>
                    <EditField label="City" value={f("city")} onChange={v => set("city", v)} />
                  </div>
                </div>
                <div className="bg-white rounded border border-slate-200 p-5">
                  <h3 className="text-xs font-bold tracking-widest uppercase text-slate-500 mb-4">Pipeline</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <EditSelect label="Status" value={f("status")} onChange={v => set("status", v)} options={STATUSES} />
                    <EditSelect label="Job Type" value={f("project_type")} onChange={v => set("project_type", v)}
                     options={projectTypes} />
                    <EditField label="Appointment Date" value={f("appointment_date")} onChange={v => set("appointment_date", v)} type="date" />
                    <EditField label="Appointment Time" value={f("appointment_time")} onChange={v => set("appointment_time", v)} />
                    <EditField label="Follow Up Date" value={f("follow_up_date")} onChange={v => set("follow_up_date", v)} type="date" />
                    <EditField label="Estimated Value ($)" value={f("estimated_value")} onChange={v => set("estimated_value", v)} type="number" />
                    <EditField label="Assigned Rep" value={f("assigned_rep")} onChange={v => set("assigned_rep", v)} />
                    <EditSelect label="Lead Source" value={f("source")} onChange={v => set("source", v)}
                      options={["Google Search","Google Maps / reviews","Referral","Instagram / Facebook","YouTube","Repeat customer","Other"]} />
                  </div>
                </div>
                <div className="bg-white rounded border border-slate-200 p-5">
                  <h3 className="text-xs font-bold tracking-widest uppercase text-slate-500 mb-4">Notes</h3>
                  <EditTextArea label="Internal Notes" value={f("notes")} onChange={v => set("notes", v)} rows={4} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div className="w-60 flex-shrink-0 bg-white border-l border-slate-200 overflow-y-auto">
          <DealsPanel lead={lead} onLeadUpdate={(updated) => { setLead(updated); setForm(updated); }} />
          <HandoffEstimatesPanel lead={lead} onLeadUpdate={(updated) => { setLead(updated); setForm(updated); }} />
          <QBStatusPanel lead={lead} />
          <AttachmentsPanel lead={lead} onLeadUpdate={(updated) => { setLead(updated); setForm(updated); }} />

          {/* Duplicate Warning */}
          {duplicates.length > 0 && (
            <div className="p-3 border-t border-slate-100 mt-2 bg-amber-50 border border-amber-200 rounded">
              <div className="text-xs font-bold text-amber-900 mb-2 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />{duplicates.length} Duplicate{duplicates.length > 1 ? 's' : ''}
              </div>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {duplicates.map(dup => (
                  <Link key={dup.id} to={`/leads/${dup.id}`}
                    className="block p-1.5 bg-white border border-amber-100 rounded hover:bg-amber-50 transition-colors text-[10px]">
                    <div className="font-semibold text-amber-900">{dup.name}</div>
                    <div className="text-amber-700">{dup.reason}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Meeting Modal */}
          {showMeetingModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-white rounded border border-slate-200 w-96 h-[600px] flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                  <h3 className="text-sm font-bold text-slate-800">Open Meeting</h3>
                  <button onClick={() => setShowMeetingModal(false)} className="text-slate-500 hover:text-slate-700">
                    <X className="w-4 h-4 text-orange" />
                  </button>
                </div>
                <iframe
                  src="https://calendar.google.com/calendar/u/0/r"
                  className="flex-1 border-0 w-full"
                  title="Google Calendar"
                />
              </div>
            </div>
          )}

          {/* Delete button */}
          <div className="p-4 border-t border-slate-100 mt-2">
            <button onClick={() => setEditing(true)}
              className="w-full flex items-center justify-center gap-2 border border-slate-200 rounded px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors mb-2">
              <Pencil className="w-3 h-3 text-orange" />Edit Details
            </button>
            <button onClick={remove}
              className="w-full flex items-center justify-center gap-2 border border-red-200 rounded px-3 py-2 text-xs font-semibold text-red-500 hover:bg-red-50 transition-colors">
              <Trash2 className="w-3 h-3 text-orange" />Delete Lead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function ActionIcon({ icon, label, onClick, href, target }) {
  const cls = "flex flex-col items-center gap-0.5 text-orange hover:text-orange transition-colors cursor-pointer group";
  const inner = (
    <>
      <div className="w-8 h-8 rounded-full border border-slate-200 flex items-center justify-center group-hover:border-orange group-hover:bg-orange/10 transition-colors">
        {icon}
      </div>
      <span className="text-[9px] font-semibold text-slate-400 group-hover:text-orange">{label}</span>
    </>
  );
  if (href) return <a href={href} target={target} rel={target === "_blank" ? "noreferrer" : undefined} className={cls}>{inner}</a>;
  return <button onClick={onClick} className={cls}>{inner}</button>;
}

function LeftSection({ title, children, collapsed, onToggle, actions }) {
  return (
    <div className="border-b border-slate-100">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors">
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-3 h-3 text-orange" /> : <ChevronDown className="w-3 h-3 text-orange" />}
          <span className="text-xs font-bold text-slate-700">{title}</span>
        </div>
        {actions && <span onClick={e => e.stopPropagation()}>{actions}</span>}
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 space-y-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, link, badge, statusColor }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">{label}</div>
      {badge && value ? (
        <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm ${statusColor}`}>{value}</span>
      ) : link && value ? (
        <a href={link} className="text-[11px] text-orange hover:underline break-all">{value}</a>
      ) : (
        <div className="text-[11px] text-slate-700">{value || <span className="text-slate-300">—</span>}</div>
      )}
    </div>
  );
}

function ActivityItem({ activity }) {
  const icons = {
    note: <Pencil className="w-3 h-3 text-white" />,
    call: <Phone className="w-3 h-3 text-white" />,
    task: <ClipboardList className="w-3 h-3 text-white" />,
    email: <Mail className="w-3 h-3 text-white" />,
    meeting: <Calendar className="w-3 h-3 text-white" />,
  };
  const colors = {
    note: "bg-yellow-100 text-yellow-600",
    call: "bg-blue-100 text-blue-600",
    task: "bg-purple-100 text-purple-600",
    email: "bg-sky-100 text-sky-600",
    meeting: "bg-emerald-100 text-emerald-600",
  };
  const labels = {
    note: "Note",
    call: "Call",
    task: "Task",
    email: "Email",
    meeting: "Meeting",
  };

  const dateObj = new Date(activity.date);
  const isValidDate = !isNaN(dateObj.getTime());
  const dateLabel = isValidDate
    ? dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
      (activity.date.includes("T") ? " " + dateObj.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "")
    : "";

  return (
    <div className="px-4 py-3 hover:bg-slate-50 transition-colors">
      <div className="flex items-start gap-3">
        <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${colors[activity.type] || "bg-slate-100 text-slate-500"}`}>
          {icons[activity.type]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <span className="text-xs font-semibold text-slate-700">
              {labels[activity.type] || activity.type}{" "}
              {activity.author && <span className="font-normal text-slate-500">by {activity.author?.split("@")[0]}</span>}
            </span>
            <span className="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0">
              {dateLabel}
            </span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">{activity.text}</p>
          {activity.metadata?.call_duration_minutes && (
            <span className="text-[10px] text-slate-500 mt-0.5 inline-block">({activity.metadata.call_duration_minutes} min)</span>
          )}
          {activity.metadata?.email_subject && (
            <div className="text-[10px] text-slate-500 mt-0.5">Subject: {activity.metadata.email_subject}</div>
          )}
          {activity.metadata?.meeting_title && (
            <div className="text-[10px] text-slate-500 mt-0.5">Meeting: {activity.metadata.meeting_title}</div>
          )}
          {activity.task?.completed && (
            <span className="text-[10px] text-emerald-600 font-semibold mt-0.5 inline-block">✓ Completed</span>
          )}
        </div>
      </div>
    </div>
  );
}

function RightSection({ title, count, children, onAdd }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={() => setCollapsed(c => !c)} className="flex items-center gap-1.5 text-xs font-bold text-slate-700 hover:text-slate-900">
          {collapsed ? <ChevronRight className="w-3 h-3 text-orange" /> : <ChevronDown className="w-3 h-3 text-orange" />}
          {title}
          {count !== undefined && <span className="text-slate-400 font-normal">({count})</span>}
        </button>
        <button onClick={onAdd} className="flex items-center gap-1 text-[10px] font-bold text-orange hover:text-orange">
          <Plus className="w-3 h-3" />Add
        </button>
      </div>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div className="flex flex-col items-center text-center px-4 py-5 gap-2">
      {icon}
      <p className="text-[10px] text-slate-400 leading-relaxed">{text}</p>
    </div>
  );
}

function EditField({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase text-slate-400 mb-1">{label}</label>
      <input type={type}
        className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 transition-colors bg-slate-50"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function EditTextArea({ label, value, onChange, rows = 3 }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase text-slate-400 mb-1">{label}</label>
      <textarea rows={rows}
        className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 transition-colors bg-slate-50 resize-none"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function EditSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase text-slate-400 mb-1">{label}</label>
      <select
        className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-400 transition-colors bg-slate-50"
        value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function GoogleSyncStatus({ lead, onResync }) {
  const [resyncing, setResyncing] = useState({ contact: false, calendar: false });

  const handleResync = async (type) => {
    setResyncing(p => ({ ...p, [type]: true }));
    await onResync(type);
    setResyncing(p => ({ ...p, [type]: false }));
  };

  const contactStatus = lead.google_contact_sync_status;
  const calendarStatus = lead.google_calendar_sync_status;
  const lastSync = lead.last_google_sync;

  if (!contactStatus && !calendarStatus) return null;

  const StatusBadge = ({ status, label, error, onSync, syncing }) => {
    const styles = {
      synced: 'bg-emerald-50 border-emerald-200 text-emerald-700',
      error: 'bg-red-50 border-red-200 text-red-700',
      pending: 'bg-amber-50 border-amber-200 text-amber-700',
    };
    const icons = { synced: '✓', error: '✗', pending: '…' };
    return (
      <div className={`border rounded px-2 py-1.5 text-[10px] ${styles[status] || 'bg-slate-50 border-slate-200 text-slate-600'}`}>
        <div className="flex items-center justify-between gap-1">
          <span className="font-semibold">{icons[status] || '·'} {label}</span>
          <button onClick={onSync} disabled={syncing}
            className="text-[9px] underline opacity-70 hover:opacity-100 disabled:opacity-40">
            {syncing ? '…' : 'Sync'}
          </button>
        </div>
        {error && <div className="mt-0.5 text-[9px] opacity-80 break-all">{error}</div>}
      </div>
    );
  };

  return (
    <div className="px-4 py-3 border-b border-slate-100 space-y-1.5">
      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Google Sync</div>
      {contactStatus && (
        <StatusBadge status={contactStatus} label="Google Contact" error={lead.google_contact_sync_error}
          onSync={() => handleResync('contact')} syncing={resyncing.contact} />
      )}
      {calendarStatus && (
        <StatusBadge status={calendarStatus} label="Google Calendar" error={lead.google_calendar_sync_error}
          onSync={() => handleResync('calendar')} syncing={resyncing.calendar} />
      )}
      {lastSync && (
        <div className="text-[9px] text-slate-400 mt-0.5">
          Last synced: {new Date(lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

function SidebarField({ label, children }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">{label}</div>
      <style>{`.sidebar-input { width: 100%; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px 8px; font-size: 11px; color: #334155; background: #f8fafc; outline: none; } .sidebar-input:focus { border-color: #60a5fa; }`}</style>
      {children}
    </div>
  );
}

function SidebarTextInput({ value: initialValue, onSave, type = "text" }) {
  const [val, setVal] = useState(initialValue);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { setVal(initialValue); setDirty(false); }, [initialValue]);

  return (
    <div className="flex gap-1 items-center">
      <input
        type={type}
        className="sidebar-input flex-1"
        value={val}
        onChange={e => { setVal(e.target.value); setDirty(true); }}
        onBlur={() => { if (dirty) { onSave(val); setDirty(false); } }}
        onKeyDown={e => { if (e.key === "Enter") { onSave(val); setDirty(false); e.target.blur(); } }}
      />
    </div>
  );
}

function CurrencyInput({ value: initialValue, onSave }) {
  const [focused, setFocused] = useState(false);
  const [rawVal, setRawVal] = useState(initialValue != null ? String(initialValue) : "");

  useEffect(() => {
    setRawVal(initialValue != null ? String(initialValue) : "");
  }, [initialValue]);

  const formatDisplay = (num) => {
    if (num === "" || num == null) return "";
    const n = parseFloat(num);
    if (isNaN(n)) return "";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const handleChange = (e) => {
    // Allow only digits and one decimal point
    const cleaned = e.target.value.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    const sanitized = parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
    setRawVal(sanitized);
  };

  const handleBlur = () => {
    setFocused(false);
    const num = parseFloat(rawVal);
    if (!isNaN(num)) {
      onSave(num);
      setRawVal(String(num));
    } else {
      onSave(null);
      setRawVal("");
    }
  };

  return (
    <div className="flex items-center border border-slate-200 rounded bg-[#f8fafc] focus-within:border-blue-400 overflow-hidden">
      <span className="pl-2 pr-1 text-[11px] font-bold text-slate-500 flex-shrink-0">$</span>
      <input
        type="text"
        className="flex-1 py-1 pr-2 text-[11px] text-slate-700 bg-transparent outline-none min-w-0"
        value={focused ? rawVal : formatDisplay(rawVal)}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
        placeholder="0.00"
      />
    </div>
  );
}