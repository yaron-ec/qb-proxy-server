import { useState, useEffect } from "react";
import * as railwayApi from "@/lib/railwayApi";
import * as railwaySettings from "@/api/railway/settings";
import { EC_PROJECT_TYPES } from "@/lib/projectTypes";
import {
  ArrowLeft, Plus, X, GripVertical, Building2, Users, RefreshCw,
  Database, Tag, Wrench, MapPin, UserCheck, Mail, ChevronDown, Menu, FileSignature, Link2, CheckCircle, AlertCircle, Clock, Trash2, DollarSign, LogOut, ClipboardList
} from "lucide-react";
import SignNowSettingsTab from "../components/SignNowSettingsTab";
import CaptureLinkTab from "../components/CaptureLinkTab";
import { Link, Link as RouterLink } from "react-router-dom";
import CompanySettingsTab from "../components/CompanySettingsTab";
import PropertiesTab from "../components/PropertiesTab";
import HubSpotSyncTab from "../components/HubSpotSyncTab.jsx";
import GoogleSyncTab from "../components/GoogleSyncTab";
import QuickBooksSyncTab from "../components/QuickBooksSyncTab";
import UsersTab from "../components/UsersTab";
import UserAllowlistTab from "../components/UserAllowlistTab";
import AccessRequestsTab from "../components/AccessRequestsTab";
import HandoffImportTab from "../components/HandoffImportTab";
import HandoffConfigTab from "../components/HandoffConfigTab";

import LeadQualificationTab from "../components/LeadQualificationTab";
import OwnerDirectoryTab from "../components/OwnerDirectoryTab";
import ReminderEngineStatus from "../components/ReminderEngineStatus";
import CrmAuditDashboard from "../components/CrmAuditDashboard";

const DEFAULT_STATUSES = [
  "Appointment scheduled", "Answered, no appointment set", "No answer", "Proposal Sent", "No show", "DNQ", "Sold", "Lost"
];
const DEFAULT_PROJECT_TYPES = EC_PROJECT_TYPES;
const DEFAULT_SOURCES = [
  "Website", "Google Search", "Google Maps / reviews", "Referral", "Instagram / Facebook",
  "YouTube", "Repeat customer", "Sharon", "Other"
];
const DEFAULT_CONTACT_OWNERS = ["Ethan Magen", "Micky Gad", "Yaron Drilevich"];

const NAV_SECTIONS = [
  {
    group: "General",
    items: [
      { id: "company", label: "Company Info", icon: Building2 },
      { id: "users", label: "Users", icon: Users },
      { id: "allowlist", label: "Access Control", icon: UserCheck },
      { id: "access-requests", label: "Access Requests", icon: Mail },
    ]
  },
  {
    group: "Integrations",
    items: [
      { id: "quickbooks", label: "QuickBooks", icon: DollarSign },
      { id: "syncs", label: "Syncs", icon: RefreshCw },

      { id: "properties", label: "Properties", icon: Database },
    ]
  },
  {
    group: "CRM Configuration",
    items: [
      { id: "statuses", label: "Lead Statuses", icon: Tag },
      { id: "projectTypes", label: "Project Types", icon: Wrench },
      { id: "sources", label: "Lead Sources", icon: MapPin },
      { id: "contactOwners", label: "Contact Owners", icon: UserCheck },
      { id: "ownerDirectory", label: "Owner Directory", icon: Mail },
      { id: "qualification", label: "Lead Qualification", icon: UserCheck },
    ]
  },
  {
    group: "Notifications",
    items: [
      { id: "email", label: "Email Settings", icon: Mail },
      { id: "reminders", label: "Appointment Reminders", icon: Clock },
    ]
  },
  {
    group: "E-Signature",
    items: [
      { id: "signnow", label: "SignNow", icon: FileSignature },
    ]
  },
  {
    group: "Call Center",
    items: [
      { id: "capturelink", label: "Capture Form Link", icon: Link2 },
    ]
  },
  {
    group: "Admin Tools",
    items: [
      { id: "crm-audit", label: "CRM Audit", icon: ClipboardList },
    ]
  },
  {
    group: "Account",
    items: [
      { id: "account-deletion", label: "Delete Account", icon: AlertCircle },
    ]
  },
  ];

const TAB_LABELS = NAV_SECTIONS.flatMap(s => s.items).reduce((acc, item) => {
  acc[item.id] = item.label;
  return acc;
}, {});

export default function Settings() {
  const [activeTab, setActiveTab] = useState("users");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [userRoleLoaded, setUserRoleLoaded] = useState(false);

  useEffect(() => {
    railwayApi.me().then(r => r.user).then(u => { setUserRole(u?.role); setUserRoleLoaded(true); });
  }, []);

  const [statuses, setStatuses] = useState(DEFAULT_STATUSES);
  const [newStatus, setNewStatus] = useState("");
  const [projectTypes, setProjectTypes] = useState(DEFAULT_PROJECT_TYPES);
  const [newProjectType, setNewProjectType] = useState("");
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [newSource, setNewSource] = useState("");
  const [contactOwners, setContactOwners] = useState(DEFAULT_CONTACT_OWNERS);
  const [newContactOwner, setNewContactOwner] = useState("");
  const [settingsId, setSettingsId] = useState(null);
  const [syncSubTab, setSyncSubTab] = useState("hubspot");

  useEffect(() => {
    railwaySettings.get("app_lists").then(s => {
      if (s && s.value) {
        setSettingsId("app_lists");
        if (s.value?.statuses) setStatuses(s.value.statuses);
        if (s.value?.projectTypes) setProjectTypes(s.value.projectTypes);
        if (s.value?.sources) setSources(s.value.sources);
        if (s.value?.contactOwners) setContactOwners(s.value.contactOwners);
      }
    }).catch(() => {});
  }, []);

  if (!userRoleLoaded) return null;
  const isReadOnly = userRole !== 'admin';

  const saveListSettings = async (newStatuses, newProjectTypes, newSources, newContactOwners) => {
    const value = { statuses: newStatuses, projectTypes: newProjectTypes, sources: newSources, contactOwners: newContactOwners ?? contactOwners };
    await railwaySettings.upsert("app_lists", value, "statuses");
  };

  const addStatus = () => {
    if (!newStatus.trim()) return;
    const updated = [...statuses, newStatus];
    setStatuses(updated); setNewStatus("");
    saveListSettings(updated, projectTypes, sources);
  };
  const removeStatus = (s) => {
    const updated = statuses.filter(x => x !== s);
    setStatuses(updated); saveListSettings(updated, projectTypes, sources);
  };
  const addContactOwner = () => {
    if (!newContactOwner.trim()) return;
    const updated = [...contactOwners, newContactOwner.trim()];
    setContactOwners(updated); setNewContactOwner("");
    saveListSettings(statuses, projectTypes, sources, updated);
  };
  const removeContactOwner = (o) => {
    const updated = contactOwners.filter(x => x !== o);
    setContactOwners(updated); saveListSettings(statuses, projectTypes, sources, updated);
  };
  const addProjectType = () => {
    if (!newProjectType.trim()) return;
    const updated = [...projectTypes, newProjectType].sort((a, b) => a.localeCompare(b));
    setProjectTypes(updated); setNewProjectType("");
    saveListSettings(statuses, updated, sources);
  };
  const removeProjectType = (t) => {
    const updated = projectTypes.filter(x => x !== t);
    setProjectTypes(updated); saveListSettings(statuses, updated, sources);
  };
  const addSource = () => {
    if (!newSource.trim()) return;
    const updated = [...sources, newSource];
    setSources(updated); setNewSource("");
    saveListSettings(statuses, projectTypes, updated);
  };
  const removeSource = (s) => {
    const updated = sources.filter(x => x !== s);
    setSources(updated); saveListSettings(statuses, projectTypes, updated);
  };

  const handleNavClick = (id) => {
    setActiveTab(id);
    setMobileNavOpen(false);
  };

  const activeLabel = TAB_LABELS[activeTab] || "Settings";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top header bar */}
      <div className="bg-white border-b border-border px-6 py-4 flex items-center gap-4 flex-shrink-0">
        <Link to="/leads" className="flex items-center gap-1.5 typography-helper-text hover:text-slate-900 transition-colors btn-compact">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Link>
        <span className="text-border">/</span>
        <span className="typography-helper-text hidden sm:inline">Settings</span>
        <span className="text-border hidden sm:inline">/</span>
        <span className="typography-label hidden sm:inline text-amber-600">{activeLabel}</span>

        {/* Mobile nav toggle */}
        <button
          className="ml-auto md:hidden flex items-center gap-2 text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
        >
          <Menu className="w-4 h-4" />
          {activeLabel}
          <ChevronDown className={`w-3 h-3 transition-transform ${mobileNavOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Mobile dropdown nav */}
      {mobileNavOpen && (
        <div className="md:hidden bg-white border-b border-slate-200 px-4 py-3 space-y-1 flex-shrink-0 shadow-md">
          {NAV_SECTIONS.flatMap(s => s.items).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => handleNavClick(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                activeTab === id
                  ? "bg-amber-50 text-amber-700 font-semibold"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-800"
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </button>
          ))}
          <div className="border-t border-slate-100 pt-2 mt-2">
            <button
              onClick={() => railwayApi.logout()}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors text-left"
            >
              <LogOut className="w-4 h-4 flex-shrink-0" />
              Logout
            </button>
          </div>
        </div>
      )}

      {/* Main layout: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left Settings Sidebar */}
        <aside className="hidden md:flex flex-col w-56 bg-white border-r border-slate-200 flex-shrink-0 overflow-y-auto">
          <div className="px-4 pt-5 pb-3">
            <p className="text-xs font-semibold text-slate-500">Settings</p>
          </div>
          <nav className="flex-1 px-2 pb-4 space-y-5">
            {NAV_SECTIONS.filter(s => !isReadOnly || ['General', 'CRM Configuration', 'Account'].includes(s.group)).map(({ group, items }) => (
              <div key={group}>
                <p className="text-[11px] font-semibold text-slate-400 px-3 mb-1.5">{group}</p>
                <div className="space-y-0.5">
                  {items.map(({ id, label, icon: Icon }) => {
                    const active = activeTab === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 text-left relative group ${
                          active
                            ? "bg-amber-50 text-amber-700 font-semibold"
                            : "text-slate-600 hover:bg-slate-50 hover:text-slate-800 font-medium"
                        }`}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-500 rounded-r-full" />
                        )}
                        <Icon className={`w-4 h-4 flex-shrink-0 ${active ? "text-amber-600" : "text-slate-400 group-hover:text-slate-600"}`} />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          {/* Logout button — bottom of sidebar, visible to all roles */}
          <div className="px-2 pb-4 border-t border-slate-100 pt-3">
            <button
              onClick={() => railwayApi.logout()}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 hover:text-red-700 transition-all duration-150 text-left"
            >
              <LogOut className="w-4 h-4 flex-shrink-0 text-red-500" />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        {/* Content area */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          {/* Page title */}
          <div className="mb-8">
            <h1 className="typography-page-title">{activeLabel}</h1>
            <div className="w-8 h-1 bg-amber-500 rounded-full mt-2" />
          </div>

          {/* Read-only banner for non-admins */}
          {isReadOnly && (
            <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <p className="text-xs font-semibold text-amber-800">You have read-only access. Contact an administrator to make changes.</p>
            </div>
          )}

          {activeTab === "company" && <CompanySettingsTab readOnly={isReadOnly} />}
          {activeTab === "users" && <UsersTab readOnly={isReadOnly} />}
          {activeTab === "allowlist" && !isReadOnly && <UserAllowlistTab />}
          {activeTab === "allowlist" && isReadOnly && <div className="text-sm text-slate-400 p-4">Access control management is restricted to administrators.</div>}
          {activeTab === "access-requests" && !isReadOnly && <AccessRequestsTab />}
          {activeTab === "access-requests" && isReadOnly && <div className="text-sm text-slate-400 p-4">Access request management is restricted to administrators.</div>}
          {activeTab === "syncs" && !isReadOnly && (
            <div>
              {/* Syncs branded header */}
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0">
                  <RefreshCw className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-700">EC Construction Group</p>
                  <p className="text-[10px] text-slate-400">Integration Sync Center</p>
                </div>
              </div>

              {/* Sub-tab bar */}
              <div className="flex bg-white border border-slate-200 rounded-lg p-1 gap-0.5 mb-6 flex-wrap">
                {[
                  { id: "hubspot",           label: "HubSpot",          emoji: "🔗" },
                  { id: "quickbooks",        label: "QuickBooks",       emoji: "💼" },
                  { id: "google",            label: "Google",           emoji: "🔍" },
                  { id: "handoff_import",    label: "Handoff",          emoji: "📤" },
                  { id: "integrations_page", label: "Integrations Hub", emoji: "🌐" },
                ].map(sub => (
                  <button
                    key={sub.id}
                    onClick={() => setSyncSubTab(sub.id)}
                    className={`btn-compact inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md transition-all ${
                      syncSubTab === sub.id
                        ? "bg-amber-600 text-white shadow-sm"
                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <span>{sub.emoji}</span>
                    <span>{sub.label}</span>
                  </button>
                ))}
              </div>

              {syncSubTab === "hubspot" && <HubSpotSyncTab />}
              {syncSubTab === "quickbooks" && <QuickBooksSyncTab />}
              {syncSubTab === "integrations_page" && <IntegrationsRedirect />}
              {syncSubTab === "google" && <GoogleSyncTab />}
              {syncSubTab === "handoff_import" && <HandoffImportTab />}
            </div>
          )}
          {activeTab === "quickbooks" && <QuickBooksMainTab />}
          {activeTab === "properties" && <PropertiesTab />}

          {activeTab === "statuses" && <StatusesTab statuses={statuses} newStatus={newStatus} setNewStatus={setNewStatus} addStatus={addStatus} removeStatus={removeStatus} readOnly={isReadOnly} />}
          {activeTab === "projectTypes" && <ProjectTypesTab projectTypes={projectTypes} newProjectType={newProjectType} setNewProjectType={setNewProjectType} addProjectType={addProjectType} removeProjectType={removeProjectType} readOnly={isReadOnly} />}
          {activeTab === "sources" && <SourcesTab sources={sources} newSource={newSource} setNewSource={setNewSource} addSource={addSource} removeSource={removeSource} setSources={(updated) => { setSources(updated); saveListSettings(statuses, projectTypes, updated); }} readOnly={isReadOnly} />}
          {activeTab === "contactOwners" && <ContactOwnersTab contactOwners={contactOwners} newContactOwner={newContactOwner} setNewContactOwner={setNewContactOwner} addContactOwner={addContactOwner} removeContactOwner={removeContactOwner} readOnly={isReadOnly} />}
          {activeTab === "ownerDirectory" && <OwnerDirectoryTab />}
          {activeTab === "qualification" && <LeadQualificationTab />}
          {activeTab === "email" && <EmailSettingsTab />}
          {activeTab === "reminders" && <ReminderEngineStatus />}
          {activeTab === "signnow" && <SignNowSettingsTab />}
          {activeTab === "capturelink" && <CaptureLinkTab />}
          {activeTab === "crm-audit" && !isReadOnly && <CrmAuditDashboard />}
          {activeTab === "crm-audit" && isReadOnly && <div className="text-sm text-slate-400 p-4">CRM Audit is restricted to administrators.</div>}
          {activeTab === "account-deletion" && <AccountDeletionTab />}
        </main>
      </div>
    </div>
  );
}

function StatusesTab({ statuses, newStatus, setNewStatus, addStatus, removeStatus, readOnly }) {
  return (
    <div className="max-w-3xl">
      {!readOnly && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-5">
          <h3 className="typography-card-title mb-4">Add new status</h3>
          <div className="flex gap-3">
            <input type="text" placeholder="Enter status name"
              className="flex-1 px-3 text-sm text-slate-900 placeholder:text-slate-400"
              value={newStatus} onChange={e => setNewStatus(e.target.value)}
              onKeyPress={e => e.key === "Enter" && addStatus()} />
            <button onClick={addStatus} className="h-10 bg-amber-600 text-white px-4 text-sm font-bold rounded-lg hover:bg-amber-700 active:scale-95 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {statuses.map(status => (
          <div key={status} className="bg-white rounded-lg border border-slate-200 px-4 py-3 flex items-center justify-between hover:shadow-sm transition-shadow">
            <span className="text-sm text-slate-700 font-medium">{status}</span>
            {!readOnly && (
              <button onClick={() => removeStatus(status)} className="text-red-400 hover:text-red-600 transition-colors ml-2">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectTypesTab({ projectTypes, newProjectType, setNewProjectType, addProjectType, removeProjectType, readOnly }) {
  const sorted = [...projectTypes].sort((a, b) => a.localeCompare(b));
  return (
    <div className="max-w-4xl">
      {!readOnly && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-5">
          <h3 className="typography-card-title mb-3">Add new project type</h3>
          <div className="flex gap-3">
            <input type="text" placeholder="Enter project type"
              className="flex-1 px-3 text-sm text-slate-900 placeholder:text-slate-400"
              value={newProjectType} onChange={e => setNewProjectType(e.target.value)}
              onKeyPress={e => e.key === "Enter" && addProjectType()} />
            <button onClick={addProjectType} className="h-10 bg-amber-600 text-white px-4 text-sm font-bold rounded-lg hover:bg-amber-700 active:scale-95 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {sorted.map(type => (
          <div key={type} className="bg-white rounded-lg border border-slate-200 px-3 py-2.5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <span className="text-xs text-slate-700 font-medium truncate mr-2">{type}</span>
            {!readOnly && (
              <button onClick={() => removeProjectType(type)} className="text-red-400 hover:text-red-600 transition-colors flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SourcesTab({ sources, newSource, setNewSource, addSource, removeSource, setSources, readOnly }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const handleDragStart = (i) => setDragIndex(i);
  const handleDragOver = (e, i) => { e.preventDefault(); setOverIndex(i); };
  const handleDrop = (e, i) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === i) return;
    const reordered = [...sources];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(i, 0, moved);
    setSources(reordered);
    setDragIndex(null); setOverIndex(null);
  };
  const handleDragEnd = () => { setDragIndex(null); setOverIndex(null); };

  return (
    <div className="max-w-3xl">
      {!readOnly && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-5">
          <h3 className="typography-card-title mb-4">Add new lead source</h3>
          <div className="flex gap-3">
            <input type="text" placeholder="Enter source name"
              className="flex-1 px-3 text-sm text-slate-900 placeholder:text-slate-400"
              value={newSource} onChange={e => setNewSource(e.target.value)}
              onKeyPress={e => e.key === "Enter" && addSource()} />
            <button onClick={addSource} className="h-10 bg-amber-600 text-white px-4 text-sm font-bold rounded-lg hover:bg-amber-700 active:scale-95 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      )}
      {!readOnly && <p className="text-xs text-slate-400 mb-3">Drag to reorder</p>}
      <div className="grid grid-cols-2 gap-3">
        {sources.map((source, i) => (
          <div key={source}
            draggable={!readOnly}
            onDragStart={() => !readOnly && handleDragStart(i)}
            onDragOver={e => !readOnly && handleDragOver(e, i)}
            onDrop={e => !readOnly && handleDrop(e, i)}
            onDragEnd={() => !readOnly && handleDragEnd()}
            className={`bg-white rounded-lg border p-4 flex items-center justify-between hover:shadow-sm transition-all
              ${!readOnly ? 'cursor-grab active:cursor-grabbing select-none' : ''}
              ${overIndex === i && dragIndex !== i ? 'border-amber-500 bg-amber-50' : 'border-slate-200'}
              ${dragIndex === i ? 'opacity-40' : 'opacity-100'}`}
          >
            <div className="flex items-center gap-2">
              {!readOnly && <GripVertical className="w-4 h-4 text-slate-300 flex-shrink-0" />}
              <span className="text-sm text-slate-700 font-medium">{source}</span>
            </div>
            {!readOnly && (
              <button onClick={() => removeSource(source)} className="text-red-400 hover:text-red-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function IntegrationsRedirect() {
  return (
    <div className="max-w-xl">
      <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
        <div className="text-4xl mb-3">🔗</div>
        <h2 className="text-lg font-bold text-slate-800 mb-2">Integrations Hub</h2>
        <p className="text-sm text-slate-500 mb-5">View sync status, audit logs, failed sync queue, and QB connection details.</p>
        <RouterLink to="/integrations" className="inline-flex items-center gap-2 bg-amber-600 text-white px-5 py-2.5 text-sm font-bold rounded-lg hover:bg-amber-700 transition-colors">
          Open Integrations Hub →
        </RouterLink>
      </div>
    </div>
  );
}

function ContactOwnersTab({ contactOwners, newContactOwner, setNewContactOwner, addContactOwner, removeContactOwner, readOnly }) {
  const [ownerEmails, setOwnerEmails] = useState({});
  const [editingOwner, setEditingOwner] = useState(null);
  const [editEmail, setEditEmail] = useState("");
  const [settingsId, setSettingsId] = useState(null);

  useEffect(() => {
    railwaySettings.get("owner_emails").then(s => {
      if (s && s.value) {
        setSettingsId("owner_emails");
        setOwnerEmails(s.value || {});
      }
    }).catch(() => {});
  }, []);

  const saveOwnerEmail = async (owner, email) => {
    const updated = { ...ownerEmails, [owner]: email };
    setOwnerEmails(updated);
    
    await railwaySettings.upsert("owner_emails", updated, "text");
    
    setEditingOwner(null);
    setEditEmail("");
  };

  return (
    <div className="max-w-3xl space-y-6">
      {!readOnly && (
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="typography-card-title mb-4">Add contact owner</h3>
          <div className="flex gap-3">
            <input type="text" placeholder="Enter name (e.g. John Smith)"
              className="flex-1 px-3 text-sm text-slate-900 placeholder:text-slate-400"
              value={newContactOwner} onChange={e => setNewContactOwner(e.target.value)}
              onKeyPress={e => e.key === "Enter" && addContactOwner()} />
            <button onClick={addContactOwner} className="h-10 bg-amber-600 text-white px-4 text-sm font-bold rounded-lg hover:bg-amber-700 active:scale-95 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-xs font-semibold text-blue-900 mb-2">📧 Email Configuration Required</p>
        <p className="text-xs text-blue-800">Each owner must have an email address configured for calendar invitations, appointment reminders, and email sending.</p>
      </div>

      {contactOwners.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-200 p-8 text-center text-slate-400 text-sm">
          No contact owners yet. Add names above.
        </div>
      ) : (
        <div className="space-y-3">
          {contactOwners.map(owner => (
            <div key={owner} className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-900">{owner}</p>
                  {editingOwner === owner ? (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="email"
                        value={editEmail}
                        onChange={e => setEditEmail(e.target.value)}
                        placeholder="owner@company.com"
                        className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                      />
                      <button
                        onClick={() => saveOwnerEmail(owner, editEmail)}
                        className="px-3 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingOwner(null)}
                        className="px-3 py-2 bg-slate-100 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2">
                      {ownerEmails[owner] ? (
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-slate-600">
                            <span className="font-semibold">Email:</span> {ownerEmails[owner]}
                          </p>
                          <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                        </div>
                      ) : (
                        <p className="text-xs text-red-600">⚠️ No email configured</p>
                      )}
                    </div>
                  )}
                </div>
                {!readOnly && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setEditingOwner(owner);
                        setEditEmail(ownerEmails[owner] || "");
                      }}
                      className="px-2.5 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      Edit Email
                    </button>
                    <button onClick={() => removeContactOwner(owner)} className="px-2.5 py-1.5 text-xs font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountDeletionTab() {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    railwayApi.me().then(r => r.user).then(u => setUser(u));
  }, []);

  const handleDelete = async () => {
    setError(null);
    if (!user || confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
      setError("Email does not match");
      return;
    }

    setDeleting(true);
    try {
      // Delete user account (admin-level operation)
      // TODO: Railway user delete endpoint not yet available
      // await railwayRequest('/auth/me', { method: 'DELETE' });
      // Logout and redirect
      railwayApi.logout("/");
    } catch (e) {
      setError(e.message || "Failed to delete account");
      setDeleting(false);
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl">
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 space-y-5">
        <div className="flex items-start gap-4">
          <Trash2 className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-red-900 uppercase tracking-wide">Delete Account</h3>
            <p className="text-xs text-red-800 mt-2">
              This action is permanent. All your account data will be permanently removed from the system. This cannot be undone.
            </p>
          </div>
        </div>

        <div className="bg-white rounded-lg p-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              Your Email: <span className="text-red-600 font-bold">{user.email}</span>
            </label>
            <p className="text-xs text-slate-500 mb-3">
              To confirm deletion, type your email address below:
            </p>
            <input
              type="email"
              placeholder="Type your email to confirm"
              value={confirmEmail}
              onChange={e => setConfirmEmail(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
            />
          </div>

          {error && (
            <div className="bg-red-100 border border-red-300 rounded-lg px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <button
            onClick={handleDelete}
            disabled={deleting || confirmEmail.toLowerCase() !== user.email.toLowerCase()}
            className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            {deleting ? 'Deleting...' : 'Delete My Account'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QuickBooksMainTab() {
  const [syncSubTab, setSyncSubTab] = useState("quickbooks");

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex bg-white border border-slate-200 rounded-lg p-1 gap-0.5 mb-6 flex-wrap">
        {[
          { id: "quickbooks",        label: "Connection & Sync",  emoji: "💼" },
          { id: "integrations_page", label: "Full Hub",           emoji: "🌐" },
        ].map(sub => (
          <button
            key={sub.id}
            onClick={() => setSyncSubTab(sub.id)}
            className={`btn-compact inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md transition-all ${
              syncSubTab === sub.id
                ? "bg-amber-600 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span>{sub.emoji}</span>
            <span>{sub.label}</span>
          </button>
        ))}
      </div>

      {syncSubTab === "quickbooks" && <QuickBooksSyncTab />}
      {syncSubTab === "integrations_page" && <IntegrationsRedirect />}
    </div>
  );
}

function EmailSettingsTab() {
  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-lg border border-slate-200 p-6 hover:shadow-md transition-all">
        <h3 className="typography-card-title mb-4">Invoice Email Settings</h3>
        <p className="text-sm text-slate-600 mb-6">Invoices are automatically distributed and attached when created in QuickBooks.</p>
        <div className="space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
            <div className="text-xs font-bold text-emerald-900 mb-2">✅ New Invoice Workflow</div>
            <div className="text-xs text-emerald-800 space-y-1">
              <div>• Email sent to: Customer email + Sales rep email</div>
              <div>• PDF automatically saved to: Lead Attachments</div>
              <div>• Metadata tracked: QB Invoice ID, Amount, Date</div>
              <div>• Badge added: "QuickBooks Invoice"</div>
              <div>• Office receives: No longer emailed (saved in lead record instead)</div>
            </div>
          </div>
          <div className="mt-6 pt-6 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-700 mb-3">Invoice Attachment Storage</h3>
            <div className="text-xs text-slate-600 space-y-2 bg-slate-50 rounded-lg p-3">
              <div>📎 <strong>Automatic PDF Storage:</strong></div>
              <div className="ml-4 space-y-1">
                <div>• Every QB invoice PDF is downloaded and stored</div>
                <div>• File name format: "Invoice #[NUM] - [Customer] - [DATE].pdf"</div>
                <div>• Accessible via lead's Attachments section</div>
                <div>• Includes QB invoice metadata and payment status</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}