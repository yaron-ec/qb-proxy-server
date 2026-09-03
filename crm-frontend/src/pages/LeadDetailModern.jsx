import React, { useState, useEffect } from "react";
import { friendlyFnError } from "@/lib/fnError";
import { EC_PROJECT_TYPES } from "@/lib/projectTypes";
import { useParams, useNavigate, Link } from "react-router-dom";
import TruncatedTooltip from "@/components/TruncatedTooltip";
import { leads as railwayLeads, activities as railwayActivities } from "@/api/railway";
import { useAuth } from "@/lib/AuthContext";
import { statusBadgeClass } from "@/lib/design-system";
import { fmtMoney, formatPhone, toTitleCase, formatProjectType } from "@/lib/formatters";
import { callPhone, sendSMS, composeEmail } from "@/lib/contactActions";
import {
  ArrowLeft, Phone, Mail, Calendar, CheckCircle2, Clock,
  Pencil, Trash2, MessageSquare, AlertCircle, FileText,
  Check, Copy, MapPin, Briefcase, User, RefreshCw,
  DollarSign, AlertTriangle, ExternalLink, FileSignature,
  Paperclip, TrendingUp, History, ChevronDown, ChevronUp, Bell, BellOff
} from "lucide-react";
import Tip from "@/components/ui/Tip";
import ContactActions from "@/components/ContactActions";
import ContactInfoEditor from "@/components/ContactInfoEditor";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { StatusBadge, Card, CardHeader, CardContent, SectionTitle, Label, Button } from "@/components/DesignSystem";
import DealsPanel from "../components/DealsPanel";
import AvailableTimePicker from "../components/AvailableTimePicker";
import FollowUpScheduler from "../components/FollowUpScheduler";
import ActivityComposer from "../components/ActivityComposer";
import HandoffEstimatesPanel from "../components/HandoffEstimatesPanel";
import AttachmentsPanel from "../components/AttachmentsPanel";
import QBStatusPanel from "../components/QBStatusPanel";
import PartialInvoiceFlow from "../components/PartialInvoiceFlow";
import SignNowPanel from "../components/SignNowPanel";
import CalendarSyncPanel from "../components/CalendarSyncPanel";
import GoogleContactSyncPanel from "../components/GoogleContactSyncPanel";
import AppointmentReminderPanel from "../components/AppointmentReminderPanel";
import EstimateSyncButton from "../components/EstimateSyncButton";
import ProposalPanel from "../components/ProposalPanel";
import RightSidebarAccordion from "../components/RightSidebarAccordion";
import SubmissionHistory from "../components/SubmissionHistory";

const STATUSES = ["New", "Appointment scheduled", "Answered, no appointment set", "No answer", "Proposal Sent", "No show", "DNQ", "Sold", "Lost"];
const DEFAULT_PROJECT_TYPES = EC_PROJECT_TYPES;

export default function LeadDetailModern() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activities, setActivities] = useState([]);
  const [saving, setSaving] = useState(false);
  const [projectTypes, setProjectTypes] = useState(DEFAULT_PROJECT_TYPES);
  const [contactOwners, setContactOwners] = useState([]);
  const [leadSources, setLeadSources] = useState([]);
  const [activeTab, setActiveTab] = useState("all");
  const [qbSectionExpanded, setQbSectionExpanded] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileSection, setMobileSection] = useState("activity");
  const [loadError, setLoadError] = useState(null);
  const [deals, setDeals] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const { user: authUser } = useAuth();

  useEffect(() => {
    if (authUser) setCurrentUser(authUser);
  }, [authUser]);

  useEffect(() => {
    const loadData = async () => {
      try {
        // Railway-first: try the Railway composite detail endpoint.
        // Falls back to Base44 getLeadDetail for leads not yet migrated to Railway.
        let leadData, acts, dealList, owners, pTypes, lSources;

        const data = await railwayLeads.getDetailByExternal(id);
        leadData = data.lead;
        if (leadData) {
          leadData.railway_id = leadData.id;
          leadData.id = leadData.external_ref || id;
        }
        acts = data.activities || [];
        dealList = data.deals || [];
        owners = data.contactOwners || [];
        if (data.projectTypes) pTypes = data.projectTypes;
        if (data.leadSources) lSources = data.leadSources;

        setLead(leadData);
        setActivities(acts || []);
        setDeals(dealList || []);
        setContactOwners(owners || []);
        if (pTypes) setProjectTypes(pTypes);
        if (lSources) setLeadSources(lSources);
        setLoading(false);

        // Clear new intake marker via Railway ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ update by Railway UUID (not external_ref)
        if (leadData?.is_new_intake_lead) {
          try {
            await railwayLeads.update(leadData.railway_id || id, { is_new_intake_lead: false, reviewed_at: new Date().toISOString() });
          } catch { /* non-critical */ }
        }
      } catch (error) {
        // apiCall throws errors with a .status property (not .response.status).
        // 403 = authorization denied, 401 = session expired, 404 = not found,
        // 500/503 = server/network error. Distinguish so the UI doesn't mask
        // auth failures as generic "Failed to load".
        const status = error?.status;
        const isForbidden = status === 403 || error?.message?.includes('Forbidden');
        const isAuthExpired = status === 401;
        const isNotFound = status === 404;
        const msg = isForbidden
          ? 'You do not have access to this lead.'
          : isAuthExpired
          ? 'Your session has expired. Please sign in again.'
          : isNotFound
          ? 'Lead not found. It may have been deleted.'
          : (error.message || 'Failed to load page. Please try again.');
        setLoadError(msg);
        setLoading(false);
      }
    };
    loadData();
  }, [id]);

  // Refresh lead from DB ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ used by QB panel after actions so financial sections update
  const refreshLead = async () => {
    try {
      const res = await railwayLeads.getByExternal(id);
      if (res?.lead) {
        const r = res.lead;
        r.railway_id = r.id;
        r.id = r.external_ref || id;
        setLead(r);
      }
    } catch { /* non-critical */ }
  };

  useEffect(() => {
    if (lead?.status === "Sold") setQbSectionExpanded(true);
  }, [lead?.status, lead?.id]);

  const updateField = async (field, value) => {
    // Always update by Railway UUID ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ NEVER by external_ref. Updating by
    // external_ref via updateByExternal() INSERTs with external_ref as the key,
    // which creates DUPLICATE leads for Railway-native records (no external_ref).
    // The backend PUT /:id now handles both contact and CRM fields with duplicate
    // checking, so this single path covers all field types safely.
    const railwayId = lead?.railway_id || id;
    const prevLead = lead;
    setLead(prev => ({ ...prev, [field]: value }));
    setSaving(true);
    try {
      const res = await railwayLeads.update(railwayId, { [field]: value });
      if (res?.lead) {
        const r = res.lead;
        // Preserve the external_ref-based id for routing, keep railway_id for updates
        r.railway_id = r.id;
        r.id = r.external_ref || id;
        setLead(r);
      }
    } catch (e) {
      // Revert the optimistic update so the UI reflects the actual saved state.
      setLead(prevLead);
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const handleActivityCreated = async () => {
    try {
      const data = await railwayLeads.getDetailByExternal(id);
      if (data?.activities) setActivities(data.activities);
    } catch { /* non-critical */ }
  };

  const handleDeleteLead = async () => {
    if (confirm("Delete this lead permanently?")) {
      try {
        await railwayLeads.remove(lead.railway_id || id);
        navigate("/leads");
      } catch (e) {
        alert("Failed to delete lead: " + (e.message || "You may not have permission."));
      }
    }
  };

  if (loading) return (
    <div className="h-full flex items-center justify-center bg-slate-50">
      <div className="w-7 h-7 border-2 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div>
    </div>
  );

  if (loadError) return (
    <div className="h-full flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-sm bg-white rounded-xl border border-red-200 p-6 text-center">
        <AlertCircle className="w-7 h-7 text-red-600 mx-auto mb-3" />
        <h2 className="text-sm font-bold text-slate-900 mb-2">Error Loading Lead</h2>
        <p className="text-xs text-slate-600 mb-4">{loadError}</p>
        <button onClick={() => window.location.reload()} className="px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg">Reload</button>
      </div>
    </div>
  );

  if (!lead) return (
    <div className="h-full flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-sm bg-white rounded-xl border border-slate-200 p-6 text-center">
        <AlertCircle className="w-7 h-7 text-slate-400 mx-auto mb-3" />
        <h2 className="text-sm font-bold text-slate-900 mb-2">Lead Not Found</h2>
        <Link to="/leads" className="inline-block px-4 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg">Back to Leads</Link>
      </div>
    </div>
  );

  const handleActivityUpdated = (updated) => {
    setActivities(prev => prev.map(a => a.id === updated.id ? updated : a));
  };
  const handleActivityDeleted = (id) => {
    setActivities(prev => prev.filter(a => a.id !== id));
  };

  const filteredActivities = activities
    .filter(a => activeTab === "all" || a.type === activeTab)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Right sidebar accordion sections
  const accordionSections = [
    {
      id: "handoff",
      title: "Handoff Estimates",
      icon: FileText,
      content: <HandoffEstimatesPanel lead={lead} onLeadUpdate={setLead} />,
    },
    {
      id: "deals",
      title: "Deals",
      icon: TrendingUp,
      badge: deals.length || undefined,
      content: <DealsPanel lead={lead} onLeadUpdate={setLead} />,
    },
    {
      id: "quickbooks",
      title: "QuickBooks",
      icon: DollarSign,
      content: (
        <>
          <QBStatusPanel lead={lead} onLeadUpdated={refreshLead} />
          <PartialInvoiceFlow lead={lead} onLeadUpdate={setLead} />
        </>
      ),
    },
    {
      id: "contracts",
      title: "Contracts & Signatures",
      icon: FileSignature,
      content: <SignNowPanel lead={lead} onLeadUpdate={setLead} />,
    },
    {
      id: "attachments",
      title: "Attachments",
      icon: Paperclip,
      content: <AttachmentsPanel lead={lead} />,
    },
    {
      id: "submissions",
      title: "Submission History",
      icon: History,
      content: <SubmissionHistory lead={lead} />,
    },
  ];

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Header ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="bg-white border-b border-border px-4 md:px-6 py-4 flex items-center justify-between flex-shrink-0 z-30" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <Link to="/leads" className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors flex-shrink-0 md:hidden btn-compact">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Link to="/leads" className="hidden md:flex items-center gap-1 typography-helper-text hover:text-slate-900 flex-shrink-0 btn-compact transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Leads</span>
          </Link>
        </div>
        <div className="flex items-center gap-1.5 md:hidden">
          <ContactActions phone={lead.phone} email={lead.email} size="md" />
        </div>
      </div>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Mobile Action Bar ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      {(lead.phone || lead.email) && (
        <div className="md:hidden flex items-center gap-2 px-4 py-2.5 bg-white border-b border-slate-100 flex-shrink-0">
          <ContactActions phone={lead.phone} email={lead.email} size="lg" />
        </div>
      )}

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Mobile Tab Bar ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="md:hidden flex border-b border-slate-100 bg-white flex-shrink-0">
        {[
          { id: "activity", label: "Activity" },
          { id: "info", label: "Info" },
          { id: "integrations", label: "Integrations" },
        ].map(tab => (
          <button key={tab.id} onClick={() => setMobileSection(tab.id)}
            className={`flex-1 py-2.5 text-xs font-semibold border-b-2 transition-colors btn-compact ${
              mobileSection === tab.id ? 'border-amber-500 text-amber-700' : 'border-transparent text-slate-400'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Mobile View ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="md:hidden flex-1 overflow-y-auto p-3 space-y-3" style={{ paddingBottom: 'max(3rem, env(safe-area-inset-bottom) + 1rem)' }}>
        {mobileSection === "activity" && (
          <>
            <ActivityComposer lead={lead} onActivityCreated={handleActivityCreated} />
            {filteredActivities.length === 0 ? (
              <div className="py-12 text-center">
                <Clock className="w-6 h-6 text-slate-200 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No activity yet</p>
              </div>
            ) : filteredActivities.map(a => <ActivityCard key={a.id} activity={a} currentUser={currentUser} onUpdated={handleActivityUpdated} onDeleted={handleActivityDeleted} />)}
          </>
        )}
        {mobileSection === "info" && (
          <>
            <LeftSidebarContent lead={lead} updateField={updateField} onLeadUpdate={setLead} contactOwners={contactOwners}
              projectTypes={projectTypes} leadSources={leadSources} deals={deals}
              handleDeleteLead={handleDeleteLead} currentUser={currentUser} />
          </>
        )}
        {mobileSection === "integrations" && (
          <>
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
              <ProposalPanel lead={lead} onLeadUpdate={setLead} />
            </div>
            {/* Compact integration actions row */}
            <MobileIntegrationActions lead={lead} onLeadUpdate={setLead} />
            {/* Admin: calendar sync error alert + repair */}
            {lead.google_calendar_sync_status === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <p className="text-xs font-bold text-red-700 mb-1">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Calendar sync failed</p>
                <p className="text-[11px] text-red-600">{lead.google_calendar_sync_error || 'Unknown error at intake'}</p>
                <p className="text-[11px] text-slate-500 mt-1">Use "Calendar" button above to repair.</p>
              </div>
            )}
            {currentUser?.role === 'admin' && (
              <AdminCalendarRepairButton />
            )}
            <RightSidebarAccordion sections={accordionSections} defaultOpen="handoff" />
          </>
        )}
      </div>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Desktop 3-Column Layout ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="hidden md:grid md:grid-cols-[minmax(300px,340px)_1fr_minmax(300px,340px)] flex-1 overflow-hidden gap-0 bg-white">

        {/* LEFT COLUMN */}
        <div className="overflow-y-auto border-r border-slate-100 bg-slate-50">
          <LeftSidebarContent lead={lead} updateField={updateField} onLeadUpdate={setLead} contactOwners={contactOwners}
            projectTypes={projectTypes} leadSources={leadSources} deals={deals}
            handleDeleteLead={handleDeleteLead} currentUser={currentUser} />
          {/* Desktop-only integration panels */}
          {lead.google_calendar_sync_status === 'error' && (
            <div className="mx-3 mb-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              <p className="text-xs font-bold text-red-700">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Calendar sync failed</p>
              <p className="text-[11px] text-red-600 mt-0.5">{lead.google_calendar_sync_error || 'Unknown error at intake'}</p>
            </div>
          )}
          <div className="px-0">
            <CalendarSyncPanel lead={lead} onLeadUpdate={setLead} />
          </div>
          <GoogleContactSyncPanel lead={lead} onLeadUpdate={setLead} />
          <div className="border-t border-slate-100">
            <EstimateSyncButton lead={lead} />
          </div>
          <div className="border-t border-slate-100">
            <AppointmentReminderPanel lead={lead} />
          </div>
          {currentUser?.role === 'admin' && (
            <div className="border-t border-slate-100 p-3">
              <AdminCalendarRepairButton />
            </div>
          )}
        </div>

        {/* CENTER COLUMN */}
        <div className="overflow-y-auto bg-white px-5 py-4">
          {/* Proposal launcher */}
          <div className="mb-4">
            <ProposalPanel lead={lead} onLeadUpdate={setLead} />
          </div>

          {/* Activity Composer */}
          <div className="mb-4">
            <ActivityComposer lead={lead} onActivityCreated={handleActivityCreated} />
          </div>

          {/* Activity Filter Tabs */}
          <div className="flex gap-1 flex-wrap mb-3">
            {[
              { id: "all", label: "All" },
              { id: "note", label: "Notes" },
              { id: "call", label: "Calls" },
              { id: "email", label: "Emails" },
              { id: "task", label: "Tasks" },
              { id: "meeting", label: "Meetings" },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`btn-compact px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  activeTab === tab.id
                    ? "bg-slate-900 text-white"
                    : "text-slate-500 hover:text-slate-700 hover:bg-white"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Activity Feed */}
          <div className="space-y-px">
            {filteredActivities.length === 0 ? (
              <div className="py-16 text-center">
                <Clock className="w-6 h-6 text-slate-200 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No activity yet</p>
              </div>
            ) : filteredActivities.map(activity => (
              <ActivityCard key={activity.id} activity={activity} currentUser={currentUser} onUpdated={handleActivityUpdated} onDeleted={handleActivityDeleted} />
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="overflow-y-auto border-l border-slate-100 bg-white py-3 px-3 space-y-3">
          <RightSidebarAccordion sections={accordionSections} defaultOpen={lead.status === "Sold" ? "quickbooks" : "handoff"} />
        </div>
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Left Sidebar Content (shared between mobile + desktop) ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function LeftSidebarContent({ lead, updateField, onLeadUpdate, contactOwners, projectTypes, leadSources, deals, handleDeleteLead, currentUser }) {
  const createdDate = lead.crm_created_date || lead.created_date;
  const fmt12 = (t) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  return (
    <div className="bg-white">
      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Identity block ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-orange to-amber-600 flex items-center justify-center flex-shrink-0 shadow-sm">
            <span className="text-sm font-bold text-white tracking-wide">{lead.first_name?.[0]}{lead.last_name?.[0]}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-1 min-w-0">
              <h2 className="text-base font-bold text-slate-900 flex-1 min-w-0 leading-tight break-words">{toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}</h2>
              <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                <CopyButton value={`${toTitleCase(lead.first_name)} ${toTitleCase(lead.last_name)}`} label="Name" />
              {(currentUser?.role === 'admin' || currentUser?.role === 'manager') && (
                <EditNameButton lead={lead} onSave={async (first, last) => {
                  const res = await railwayLeads.update(lead.railway_id || lead.id, { first_name: first, last_name: last });
                  if (res?.lead) onLeadUpdate({ ...lead, first_name: res.lead.first_name, last_name: res.lead.last_name });
                }} />
              )}
              </div>
            </div>
            {/* Status + Meeting Stage */}
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              <EditableField value={lead.status || "New"} onSave={v => updateField("status", v)} type="select" options={STATUSES} editable showPencil={false}>
                <span className={`${statusBadgeClass(lead.status)} cursor-pointer`}>{lead.status || "New"}</span>
              </EditableField>
              {lead.meeting_stage ? (
                <EditableField value={lead.meeting_stage} onSave={v => updateField("meeting_stage", v)} type="select" options={["First Meeting","Second Meeting","Third Meeting"]} editable showPencil={false}>
                  <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 cursor-pointer">{lead.meeting_stage}</span>
                </EditableField>
              ) : (
                <EditableField value="" onSave={v => updateField("meeting_stage", v)} type="select" options={["First Meeting","Second Meeting","Third Meeting"]} editable showPencil={false}>
                  <span className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-600">+ stage</span>
                </EditableField>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Contact section ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <SidebarSection title="Contact Info">
        <ContactInfoEditor lead={lead} onLeadUpdate={onLeadUpdate} />

        {/* Owner ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ editable (click row) + copy (no pencil) */}
        <CRMField label="Owner" icon={User}>
          <EditableField value={toTitleCase(lead.assigned_rep) || "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ"} onSave={v => updateField("assigned_rep", v)} type="select" options={contactOwners} editable
            copyValue={lead.assigned_rep ? toTitleCase(lead.assigned_rep) : null} copyLabel="Owner">
            <span className="crm-value">{toTitleCase(lead.assigned_rep) || <span className="crm-empty">Unassigned</span>}</span>
          </EditableField>
        </CRMField>

        {/* Job Type ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ editable (click row) + copy (no pencil) */}
        <CRMField label="Job Type" icon={Briefcase}>
          <EditableField value={lead.project_type} onSave={v => updateField("project_type", v)} type="multiselect" options={projectTypes} editable
            copyValue={lead.project_type ? toTitleCase(lead.project_type) : null} copyLabel="Job Type">
            <span className="crm-value">{toTitleCase(lead.project_type) || <span className="crm-empty">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>}</span>
          </EditableField>
        </CRMField>

        {/* Budget ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ editable (click row) + copy (no pencil) */}
        <CRMField label="Budget" icon={DollarSign}>
          <EditableField value={lead.budget_range || "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ"} onSave={v => updateField("budget_range", v)} type="select" options={["Under $25,000","$25,000ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ$75,000","$75,000ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ$150,000","$150,000ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ$300,000","$300,000+"]} editable
            copyValue={lead.budget_range || null} copyLabel="Budget">
            <span className="crm-value">{lead.budget_range || <span className="crm-empty">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>}</span>
          </EditableField>
        </CRMField>

        {/* Source ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ editable (click row) + copy (no pencil) */}
        <CRMField label="Source" icon={ExternalLink}>
          <EditableField value={lead.source || "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ"} onSave={v => updateField("source", v)} type="select" options={leadSources} editable
            copyValue={lead.source || null} copyLabel="Source">
            <span className="crm-value">{lead.source || <span className="crm-empty">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>}</span>
          </EditableField>
        </CRMField>

        {/* Added date */}
        <CRMField label="Added" icon={Calendar}>
          <span className="crm-value">
            {createdDate ? new Date(createdDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : <span className="crm-empty">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>}
          </span>
        </CRMField>

        {/* Customer reminder preference ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ prominent when opted out */}
        <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 border ${
          lead.customer_reminders_disabled ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            {lead.customer_reminders_disabled
              ? <BellOff className="w-4 h-4 text-amber-600 flex-shrink-0" />
              : <Bell className="w-4 h-4 text-slate-400 flex-shrink-0" />
            }
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-700 leading-tight">Customer Reminders</p>
              <p className={`text-[11px] leading-tight mt-0.5 ${lead.customer_reminders_disabled ? 'text-amber-700' : 'text-slate-400'}`}>
                {lead.customer_reminders_disabled ? 'Opted out ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ no reminder emails' : 'Reminder emails enabled'}
              </p>
            </div>
          </div>
          <Switch
            checked={!lead.customer_reminders_disabled}
            onCheckedChange={(checked) => updateField("customer_reminders_disabled", !checked)}
          />
        </div>
      </SidebarSection>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Schedule section ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <SidebarSection title="Schedule">
        {/* Appointment */}
        <InfoRow icon={Calendar}>
          <div className="flex-1 min-w-0">
            <p className="sidebar-label">Appointment</p>
            <EditableField key={`apt-${lead.appointment_date}`} value={lead.appointment_date} onSave={v => updateField("appointment_date", v)} type="date" editable>
              <span className="sidebar-value">
                {lead.appointment_date
                  ? new Date(lead.appointment_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : <span className="sidebar-empty">Not set</span>}
                {lead.appointment_time && <span className="text-slate-500 ml-1.5 font-normal">at {fmt12(lead.appointment_time)}</span>}
              </span>
            </EditableField>
            {!lead.appointment_date && lead.follow_up_date && lead.follow_up_type === "Meeting" && (
              <p className="text-[10px] text-slate-400 mt-1">No site visit on file ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ next meeting is in Follow-up below.</p>
            )}
            {/* Time picker inline below */}
            <div className="mt-1.5">
              <AppointmentTimePicker key={`apt-t-${lead.appointment_time}`} lead={lead} onSave={v => updateField("appointment_time", v)} />
            </div>
          </div>
        </InfoRow>

        {/* Follow-up */}
        <div className="mt-3">
          <FollowUpScheduler key={`fup-${lead.follow_up_date}-${lead.follow_up_time}-${lead.follow_up_type}`} lead={lead} onLeadUpdate={onLeadUpdate} />
        </div>
      </SidebarSection>

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Notes section ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      {deals.length === 0 && (
        <SidebarSection title="Notes">
          <EditableField value={lead.notes || ""} onSave={v => updateField("notes", v)} editable>
            <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap min-h-[2rem]">
              {lead.notes || <span className="text-slate-400 italic">No notes yet</span>}
            </p>
          </EditableField>
        </SidebarSection>
      )}

      {/* ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Danger zone ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ */}
      <div className="px-5 pt-6 pb-4 border-t-2 border-slate-100 mt-2">
        <p className="sidebar-section-header text-slate-300 mb-2">Danger Zone</p>
        <button onClick={handleDeleteLead} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors btn-compact border border-red-100 hover:border-red-200">
          <Trash2 className="w-3.5 h-3.5" /> Delete Lead
        </button>
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Reusable sidebar section wrapper ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function SidebarSection({ title, children }) {
  return (
    <div className="border-t border-slate-100 px-5 py-3.5">
      <p className="sidebar-section-header mb-3">{title}</p>
      <div className="space-y-3.5">{children}</div>
    </div>
  );
}

/**
 * CRMField ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ single source of truth for every info row in the left sidebar.
 * icon + label stacked above value/children, all on a consistent grid.
 */
function CRMField({ label, icon: Icon, iconClass = "text-slate-400", children }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className={`w-3.5 h-3.5 ${iconClass} flex-shrink-0 mt-[3px]`} />
      <div className="flex-1 min-w-0">
        <p className="crm-label">{label}</p>
        {children}
      </div>
    </div>
  );
}

// InfoRow kept for any external callers
function InfoRow({ icon: Icon, children, iconClass = "text-slate-400" }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className={`w-3.5 h-3.5 ${iconClass} flex-shrink-0 mt-[3px]`} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// ContactRow kept for any external callers
function ContactRow({ icon: Icon, children, iconClass = "text-slate-400" }) {
  return <InfoRow icon={Icon} iconClass={iconClass}>{children}</InfoRow>;
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Appointment Time Picker ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function AppointmentTimePicker({ lead, onSave }) {
  const [isEditing, setIsEditing] = useState(false);
  const [val, setVal] = useState(lead.appointment_time || '');
  const [availError, setAvailError] = useState(null);

  const fmt12 = (t) => {
    if (!t) return 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  const handleSave = async () => {
    onSave(val);
    setIsEditing(false);
    setAvailError(null);
  };

  if (!isEditing) {
    return (
      <button onClick={() => setIsEditing(true)} className="btn-compact text-[11px] text-slate-400 hover:text-amber-600 flex items-center gap-1 transition-colors">
        <Pencil className="w-3 h-3" />
        {lead.appointment_time ? `Edit time` : `Set time`}
      </button>
    );
  }

  return (
    <div className="space-y-1.5 mt-1">
      <AvailableTimePicker value={val} onChange={v => { setVal(v); setAvailError(null); }} date={lead.appointment_date} ownerName={lead.assigned_rep} />
      {availError && <p className="text-[11px] text-red-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{availError}</p>}
      <div className="flex gap-1.5">
        <button onClick={handleSave} className="flex-1 px-2 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors">
          Save
        </button>
        <button onClick={() => { setIsEditing(false); setVal(lead.appointment_time || ''); setAvailError(null); }} className="flex-1 px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Copy Button ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ copies a value to clipboard with a "Copied" toast ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function CopyButton({ value, label }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ title: `${label || 'Value'} copied`, duration: 1500 });
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      toast({ title: 'Copy failed', variant: 'destructive', duration: 2000 });
    }
  };

  return (
    <Tip label={copied ? "Copied!" : `Copy ${label || ''}`.trim()} side="top">
      <button
        onClick={handleCopy}
        aria-label={`Copy ${label || ''}`.trim()}
        className="btn-compact flex items-center justify-center w-6 h-6 rounded text-slate-300 hover:text-amber-500 hover:bg-amber-50 transition-colors flex-shrink-0"
      >
        {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </Tip>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ EmailEditField ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ async save with loading/error state ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function EmailEditField({ lead, updateField, composeEmail }) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    if (!val.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateField('email', val.trim());
      setIsEditing(false);
      setVal('');
      toast({ title: 'Email saved.', duration: 2000 });
    } catch (e) {
      setError(e?.message || 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (lead.email) {
    return (
      <div className="flex items-center justify-between gap-2 min-w-0">
        <TruncatedTooltip text={lead.email} className="crm-value flex-1 min-w-0" />
        <div className="flex items-center gap-1 flex-shrink-0">
          <Tip label={`Email ${lead.email}`} side="top">
                  <a href={`mailto:${lead.email}`} aria-label={`Email ${lead.email}`} className="crm-action-btn text-amber-700 hover:bg-amber-50 hover:border-amber-200"
              onClick={e => { e.preventDefault(); composeEmail(lead.email, e); }}>
              <Mail className="w-3 h-3" />
            </a>
          </Tip>
          <CopyButton value={lead.email} label="Email" />
        </div>
      </div>
    );
  }

  if (!isEditing) {
    return (
      <button onClick={() => { setVal(''); setError(null); setIsEditing(true); }}
        className="btn-compact flex items-center gap-1.5 text-xs text-slate-400 hover:text-amber-600 transition-colors group">
        <span className="crm-empty">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>
        <Pencil className="w-3 h-3 text-slate-300 group-hover:text-amber-500 transition-colors" />
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <input
        type="email"
        value={val}
        onChange={e => { setVal(e.target.value); setError(null); }}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setIsEditing(false); }}
        placeholder="email@example.com"
        autoFocus
        disabled={saving}
        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500 disabled:opacity-60"
      />
      {error && <p className="text-[11px] text-red-600 leading-tight">{error}</p>}
      <div className="flex gap-1.5">
        <button
          onClick={handleSave}
          disabled={saving || !val.trim()}
          className="flex-1 px-2 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {saving && <RefreshCw className="w-3 h-3 animate-spin" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={() => { setIsEditing(false); setVal(''); setError(null); }}
          disabled={saving}
          className="flex-1 px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ EditableField ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function EditableField({ label, value, onSave, type = "text", options = [], editable = false, showPencil = true, copyValue = null, copyLabel = null, children }) {
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const rawValue = (value === "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ" || value === null || value === undefined) ? "" : String(value);
  const [editVal, setEditVal] = useState(rawValue);
  const [selectedMulti, setSelectedMulti] = useState(() =>
    type === "multiselect" && value && value !== "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ" ? String(value).split(",").map(v => v.trim()).filter(v => v) : []
  );

  // Async-aware save: shows loading state, preserves edit values on error,
  // only exits edit mode on success. Prevents the "stuck Saving..." state.
  const handleSave = async () => {
    const saveVal = type === "multiselect" ? selectedMulti.join(", ") : editVal;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(saveVal);
      setIsEditing(false);
    } catch (e) {
      // Preserve entered values so the user can retry without re-typing.
      setSaveError(e?.message || 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (children && !isEditing) {
    const hasActions = copyValue || (editable && showPencil);
    return (
      <div onClick={() => editable && setIsEditing(true)} className={editable ? "cursor-pointer group" : ""}>
        {hasActions ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">{children}</div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {copyValue && <CopyButton value={copyValue} label={copyLabel} />}
              {editable && showPencil && <Pencil className="w-3 h-3 text-slate-300 group-hover:text-amber-500 transition-colors flex-shrink-0" />}
            </div>
          </div>
        ) : (
          <>{children}</>
        )}
      </div>
    );
  }

  const timeOptions = [];
  for (let h = 9; h < 19; h++) for (let m = 0; m < 60; m += 30)
    timeOptions.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);

  const fmt = (v) => {
    if (!v || v === "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ") return "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ";
    if (type === "date") return new Date(v + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (type === "time") { const [h,m] = v.split(":").map(Number); return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`; }
    return v;
  };

  if (isEditing) return (
    <div className="space-y-1.5">
      {label && <p className="text-[10px] text-slate-400">{label}</p>}
      {type === "multiselect" ? (
        <div className="border border-slate-200 rounded-lg p-2 space-y-1.5 max-h-36 overflow-y-auto bg-white text-xs">
          {options.map(o => (
            <label key={o} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={selectedMulti.includes(o)} onChange={() => setSelectedMulti(p => p.includes(o) ? p.filter(x => x !== o) : [...p, o])} className="w-3.5 h-3.5 rounded" />
              {o}
            </label>
          ))}
        </div>
      ) : type === "select" ? (
        <select value={editVal} onChange={e => setEditVal(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500">
          <option value="">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Select</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : type === "date" ? (
        <input type="date" value={editVal} onChange={e => setEditVal(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500" />
      ) : type === "time" ? (
        <select value={editVal} onChange={e => setEditVal(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500">
          <option value="">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Time</option>
          {timeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      ) : type === "number" ? (
        <input type="number" value={editVal} onChange={e => setEditVal(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500" />
      ) : (
        <textarea value={editVal} onChange={e => setEditVal(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-amber-500 resize-none" rows={3} />
      )}
      {saveError && <p className="text-[11px] text-red-600 leading-tight flex items-center gap-1"><AlertCircle className="w-3 h-3" />{saveError}</p>}
      <div className="flex gap-1.5">
        <button onClick={handleSave} disabled={saving} className="flex-1 px-2 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-1">
          {saving && <RefreshCw className="w-3 h-3 animate-spin" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => { setEditVal(rawValue); setSaveError(null); setIsEditing(false); }} disabled={saving} className="flex-1 px-2 py-1 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors disabled:opacity-50">Cancel</button>
      </div>
    </div>
  );

  return (
    <div onClick={() => editable && setIsEditing(true)} className={editable ? "cursor-pointer group" : ""}>
      {label && <p className="text-[10px] text-slate-400 mb-0.5">{label}</p>}
      <div className="flex items-center justify-between rounded hover:bg-slate-50 transition-colors">
        {type === "multiselect" && value ? (
          <div className="flex flex-wrap gap-1">
            {String(value).split(",").map((v, i) => (
              <span key={i} className="text-[11px] bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded">{v.trim()}</span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-800">{fmt(rawValue) || <span className="text-slate-400">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</span>}</p>
        )}
        {editable && showPencil && <Pencil className="w-3 h-3 text-slate-300 group-hover:text-amber-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />}
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Edit Name Button + Modal ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function EditNameButton({ lead, onSave }) {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState(lead.first_name || '');
  const [lastName, setLastName] = useState(lead.last_name || '');
  const [saving, setSaving] = useState(false);

  const handleOpen = (e) => {
    e.stopPropagation();
    setFirstName(lead.first_name || '');
    setLastName(lead.last_name || '');
    setOpen(true);
  };

  const handleSave = async () => {
    if (!firstName.trim()) return;
    setSaving(true);
    await onSave(firstName.trim(), lastName.trim());
    setSaving(false);
    setOpen(false);
  };

  return (
    <>
      <Tip label="Edit name">
        <button
          onClick={handleOpen}
          aria-label="Edit name"
          className="btn-compact flex items-center justify-center w-6 h-6 rounded hover:bg-amber-50 text-slate-300 hover:text-amber-500 transition-colors flex-shrink-0"
        >
          <Pencil className="w-3 h-3" />
        </button>
      </Tip>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Edit Name</h3>
              <button onClick={() => setOpen(false)} className="btn-compact p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">First Name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1">Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={saving || !firstName.trim()}
                className="flex-1 py-2.5 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? 'SavingÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦' : 'Save'}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="flex-1 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Mobile Integration Actions ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ always-visible 2ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ2 icon grid ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function MobileIntegrationActions({ lead, onLeadUpdate }) {
  const [calendarState, setCalendarState] = useState({ loading: false, result: null });
  const [contactState, setContactState] = useState({ loading: false, result: null });
  const [estimateState, setEstimateState] = useState({ loading: false, result: null });
  const [reminderState, setReminderState] = useState({ loading: false, result: null });

  // [DEBUG v2.1] proves the updated (backend-driven) component is executing.
  // Remove after Android build verification is confirmed.
  console.log('[MobileIntegrationActions] v2.1 mounted ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ backend-driven path', {
    leadId: lead.id,
    contactSyncStatus: lead.google_contact_sync_status,
    hasContactResourceName: !!lead.google_contact_resource_name,
    remindersDisabled: !!lead.customer_reminders_disabled,
  });

  const apptDate = lead.follow_up_date || lead.appointment_date;
  const today = new Date().toISOString().slice(0, 10);

  const runAction = async (key, fn) => {
    const setter = { calendar: setCalendarState, contact: setContactState, estimate: setEstimateState, reminder: setReminderState }[key];
    setter({ loading: true, result: null });
    try {
      const msg = await fn();
      setter({ loading: false, result: { ok: true, msg } });
    } catch (e) {
      setter({ loading: false, result: { ok: false, msg: friendlyFnError(e) } });
    }
  };

  const actions = [
    {
      key: 'calendar',
      label: 'Calendar',
      icon: Calendar,
      state: calendarState,
      synced: !!lead.google_event_id,
      run: () => runAction('calendar', async () => {
        // Railway-owned calendar sync ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ service account creates the event server-side.
        // No browser-side Google Calendar OAuth connector, no Base44.
        const apptDate = lead.follow_up_date || lead.appointment_date;
        if (!apptDate) throw new Error('No appointment date set for this lead.');
        const res = await railwayLeads.syncCalendar(lead.id);
        if (res?.success === false) throw new Error(res?.error || 'Calendar sync failed');
        // Refresh lead to pick up updated google_event_id / sync_status
        try {
          const updated = await railwayLeads.getByExternal(lead.id);
          if (updated?.lead) onLeadUpdate(updated.lead);
        } catch { /* non-critical */ }
        return res?.already_existed ? 'Calendar event already exists' : 'Calendar event created';
      }),
    },
    {
      key: 'contact',
      label: 'Contact',
      icon: User,
      state: contactState,
      synced: !!lead.google_contact_resource_name && lead.google_contact_sync_status === 'synced',
      error: lead.google_contact_sync_status === 'error',
      pending: lead.google_contact_sync_status === 'pending',
      run: () => runAction('contact', async () => {
        // Railway-owned contact sync ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ service account creates the contact server-side.
        // No Base44 syncSingleContactToGoogle function call.
        const res = await railwayLeads.syncContact(lead.id);
        if (res?.success === false) throw new Error(res?.error || 'Contact sync failed');
        // Refresh lead to pick up updated google_contact_sync_status / resource_name
        try {
          const updated = await railwayLeads.getByExternal(lead.id);
          if (updated?.lead) onLeadUpdate(updated.lead);
        } catch { /* non-critical */ }
        return res?.status === 'pending' ? 'Contact marked for sync' : 'Contact synced';
      }),
    },
    {
      key: 'estimate',
      label: 'Estimate',
      icon: FileText,
      state: estimateState,
      synced: false,
      run: () => runAction('estimate', async () => {
        const { railwayRequest } = await import('@/lib/railwayClient');
        const data = await railwayRequest('/qb/sync-lead-estimates', { leadId: lead.id });
        if (data?.success === false) throw new Error(data?.error || 'Sync failed');
        return data?.message || 'Estimates synced';
      }),
    },
    {
      key: 'reminder',
      label: 'Reminder',
      icon: Mail,
      state: reminderState,
      synced: false,
      // Disabled only when customer opted out or no upcoming appointment ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ NOT
      // based on a browser-side Gmail connector check. Reminders are delivered
      // by the existing sendManualReminder backend function (Gmail API, server-side).
      disabled: !apptDate || apptDate < today || !!lead.customer_reminders_disabled,
      run: () => runAction('reminder', async () => {
        // [DEBUG v2.1] proves the reminder action takes the backend path (not connector).
        console.log('[MobileIntegrationActions] reminder action ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ sendManualReminder (backend)', { leadId: lead.id });
        // Uses existing sendManualReminder backend function ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ sends staff + customer
        // reminder emails via the Gmail API path (server-side). Never checks a
        // browser-side connector, so never shows "Gmail not connected."
        const { sendManualReminder } = await import('@/lib/emailTransport');
        const res = await sendManualReminder(lead.id);
        if (res.data?.success === false) throw new Error(res.data?.error || res.data?.message || 'Reminder failed');
        return res.data?.message || 'Reminder sent';
      }),
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5 px-1">Integration Actions</p>
      <div className="grid grid-cols-2 gap-2">
        {actions.map(({ key, label, icon: Icon, state, synced, error, pending, disabled, run }) => {
          const isLoading = state.loading;
          const result = state.result;
          const hasError = result && !result.ok;
          const hasSuccess = result && result.ok;
          // A failed action never disables the card ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ it stays tappable for retry.
          // Only the underlying disabled condition (no appt / opted out) blocks taps.
          const isDisabled = !!disabled && !hasError;
          const statusText = isLoading
            ? 'RunningÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦'
            : hasError
            ? 'Failed ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ tap to retry'
            : hasSuccess
            ? 'Done ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ'
            : disabled
            ? 'Reminder disabled'
            : error
            ? 'Sync failed'
            : pending
            ? 'SyncingÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦'
            : synced
            ? 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Synced'
            : 'Tap to run';
          return (
            <div key={key} className="flex flex-col gap-1">
              <button
                onClick={run}
                disabled={isLoading || isDisabled}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all disabled:opacity-40 ${
                  hasError
                    ? 'border-red-200 bg-red-50'
                    : hasSuccess
                    ? 'border-emerald-200 bg-emerald-50'
                    : error
                    ? 'border-red-100 bg-red-50/50'
                    : synced
                    ? 'border-emerald-100 bg-emerald-50/50 hover:bg-emerald-50'
                    : 'border-slate-200 bg-slate-50 hover:bg-white hover:border-amber-300'
                }`}
              >
                <div className={`flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 ${
                  hasError ? 'bg-red-100' : hasSuccess ? 'bg-emerald-100' : error ? 'bg-red-100' : synced ? 'bg-emerald-100' : 'bg-white border border-slate-200'
                }`}>
                  {isLoading
                    ? <RefreshCw className="w-3.5 h-3.5 text-slate-400 animate-spin" />
                    : <Icon className={`w-3.5 h-3.5 ${hasError ? 'text-red-500' : hasSuccess ? 'text-emerald-600' : error ? 'text-red-500' : synced ? 'text-emerald-600' : 'text-slate-500'}`} />
                  }
                </div>
                <div className="min-w-0 text-left">
                  <p className={`text-xs font-semibold leading-tight ${hasError ? 'text-red-700' : hasSuccess ? 'text-emerald-700' : error ? 'text-red-700' : 'text-slate-700'}`}>
                    {label}
                  </p>
                  <p className={`text-[10px] leading-tight truncate ${hasError ? 'text-red-500' : hasSuccess ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {statusText}
                  </p>
                </div>
              </button>
              {result && (
                <p className={`text-[10px] px-1 leading-snug ${result.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                  {result.msg}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Admin Calendar Repair Button ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function AdminCalendarRepairButton() {
  const [state, setState] = useState({ loading: false, result: null });

  const run = async () => {
    setState({ loading: true, result: null });
    try {
      const { railwayRequest } = await import('@/lib/railwayClient');
      const data = await railwayRequest('/calendar/repair-missing-events', {});
      setState({ loading: false, result: { ok: true, data } });
    } catch (e) {
      setState({ loading: false, result: { ok: false, msg: 'Calendar repair requires Railway to be configured.' } });
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-700">Repair Missing Calendar Events</p>
        <p className="text-[11px] text-slate-400 mt-0.5">Scans all future meetings</p>
      </div>
      <button
        onClick={run}
        disabled={state.loading}
        className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 rounded-md transition-colors disabled:opacity-50"
        style={{ minHeight: 'unset', minWidth: 'unset' }}
      >
        <RefreshCw className={`w-3 h-3 ${state.loading ? 'animate-spin' : ''}`} />
        {state.loading ? 'ScanningÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦' : 'Run Audit'}
      </button>
    </div>
      {state.result && (
        <div className={`text-[11px] rounded-lg px-3 py-2 ${state.result.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
          {state.result.ok ? (
            <>
              <p className="font-semibold">{state.result.data?.summary}</p>
              {state.result.data?.details?.missingEmail?.length > 0 && (
                <p className="mt-1 text-amber-700">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Missing email (non-blocking): {state.result.data.details.missingEmail.map(l => l.name).join(', ')}</p>
              )}
              {state.result.data?.details?.failed?.length > 0 && (
                <p className="mt-1 text-red-600">ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Failed: {state.result.data.details.failed.map(l => `${l.name} (${l.error})`).join(', ')}</p>
              )}
            </>
          ) : (
            <p>Error: {state.result.msg}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Activity Card ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ modern feed style with edit support ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ
function ActivityCard({ activity, currentUser, onUpdated, onDeleted }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(activity.content);
  const [saving, setSaving] = useState(false);

  const cfg = {
    note:    { dot: "bg-blue-400",   label: "Note",    color: "text-blue-600"   },
    call:    { dot: "bg-green-500",  label: "Call",    color: "text-green-700"  },
    email:   { dot: "bg-amber-400",  label: "Email",   color: "text-amber-700"  },
    task:    { dot: "bg-amber-400",  label: "Task",    color: "text-amber-600"  },
    meeting: { dot: "bg-purple-400", label: "Meeting", color: "text-purple-700" },
  }[activity.type] || { dot: "bg-slate-300", label: activity.type, color: "text-slate-500" };

  const callOutcome = activity.metadata?.call_outcome;
  const emailSubject = activity.metadata?.email_subject;

  const ts = new Date(activity.timestamp);
  const dateStr = ts.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const timeStr = ts.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Convert raw reminder idempotency keys to human-readable text
  const formatActivityContent = (content) => {
    if (!content) return content;
    if (content.startsWith("REMINDER_SENT:")) return "Automated reminder sent (appointment notification)";
    if (content.startsWith("PHONE_REMINDER_SENT:")) return "Automated phone call reminder sent";
    if (content.startsWith("REMINDER_TEST_SENT:")) return "Test reminder sent";
    if (content.startsWith("Reminder sent:")) return "Automated reminder sent (appointment notification)";
    if (content.startsWith("PHONE_REMINDER:")) return "Automated phone call reminder sent";
    if (content.startsWith("System:")) return content.replace("System:", "").trim() || "System activity";
    return content;
  };

  // System-generated entries (REMINDER_SENT:, etc.) are not editable
  const isSystemEntry = activity.content?.startsWith("REMINDER_SENT:") ||
    activity.content?.startsWith("PHONE_REMINDER_SENT:") ||
    activity.content?.startsWith("REMINDER_TEST_SENT:") ||
    activity.content?.startsWith("Reminder sent:") ||
    activity.content?.startsWith("PHONE_REMINDER:") ||
    activity.content?.startsWith("System:") ||
    activity.author === "System" || activity.author === "System-Test";

  // Permission: admin can edit any; others can edit their own
  const canEdit = !isSystemEntry && currentUser && (
    currentUser.role === "admin" ||
    currentUser.role === "manager" ||
    currentUser.full_name === activity.author ||
    currentUser.email === activity.author
  );

  const handleSave = async () => {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      const res = await railwayActivities.update(activity.id, {
        content: editContent.trim(),
        metadata: { ...(activity.metadata || {}), edited_at: new Date().toISOString() },
      });
      setSaving(false);
      setIsEditing(false);
      onUpdated?.(res?.activity || { ...activity, content: editContent.trim(), metadata: { ...(activity.metadata || {}), edited_at: new Date().toISOString() } });
    } catch (e) {
      setSaving(false);
      console.error('Failed to update activity:', e);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this activity entry?")) return;
    try {
      await railwayActivities.remove(activity.id);
      onDeleted?.(activity.id);
    } catch (e) {
      console.error('Failed to delete activity:', e);
    }
  };

  const editedAt = activity.metadata?.edited_at;

  return (
    <div className="group flex gap-4 py-5 px-0 border-l-2 border-l-slate-200 group-last:border-l-transparent pl-4">
      {/* Timeline dot */}
      <div className="flex flex-col items-start pt-0.5 flex-shrink-0 -ml-5">
        <div className={`w-3 h-3 rounded-full ${cfg.dot} border-2 border-white`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-bold ${cfg.color} uppercase tracking-wide`}>{cfg.label}</span>
            {callOutcome && (
              <span className="text-[10px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full font-medium">{callOutcome}</span>
            )}
            {emailSubject && (
              <span className="text-[10px] text-slate-500 italic truncate max-w-[180px]">"{emailSubject}"</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[10px] text-slate-400 whitespace-nowrap">{dateStr} at {timeStr}</span>
            {canEdit && !isEditing && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Tip label="Edit note">
                  <button
                    onClick={() => { setEditContent(activity.content); setIsEditing(true); }}
                    aria-label="Edit note"
                    className="btn-compact p-1 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </Tip>
                <Tip label="Delete note">
                  <button
                    onClick={handleDelete}
                    aria-label="Delete note"
                    className="btn-compact p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </Tip>
              </div>
            )}
          </div>
        </div>

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full border border-amber-300 rounded-lg p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none multiline-text bg-amber-50/30"
              rows={Math.max(3, editContent.split('\n').length)}
              autoFocus
            />
            <div className="flex gap-1.5">
              <button
                onClick={handleSave}
                disabled={saving || !editContent.trim()}
                className="px-3 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50"
              >
                {saving ? "SavingÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦" : "Save"}
              </button>
              <button
                onClick={() => { setIsEditing(false); setEditContent(activity.content); }}
                className="px-3 py-1 text-xs text-slate-600 border border-slate-200 rounded hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap mb-1.5">{formatActivityContent(activity.content)}</p>
        )}

        <div className="flex items-center gap-2 flex-wrap mt-1">
          {activity.author && (
            <p className="text-[10px] text-slate-400">{activity.author}</p>
          )}
          {editedAt && (
            <span className="text-[10px] text-slate-400 italic">
              ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ· edited {new Date(editedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} at {new Date(editedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}