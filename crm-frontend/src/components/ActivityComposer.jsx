/**
 * ActivityComposer
 * 
 * Unified interface for creating activities of different types:
 * - Note
 * - Call
 * - Email
 * - Task
 * - Meeting
 */
import { useState, useEffect } from "react";
import { activities as railwayActivities, leads as railwayLeads, tasks as railwayTasks, settings as railwaySettings } from "@/api/railway";
import { useAuth } from "@/lib/AuthContext";
import { AlertCircle, FileText, Phone, Mail, CheckSquare, Calendar } from "lucide-react";
import AvailableTimePicker from "./AvailableTimePicker";
import { EMAIL_TEMPLATES, renderTemplate } from "@/lib/emailTemplates";

// Standard: call=green, note=blue, email=amber, task=amber, meeting=purple
const ACTIVITY_TYPES = [
  { id: "note",    label: "Note",    icon: "note",    iconColor: "text-blue-500",   iconBg: "bg-blue-50",   tabActiveColor: "text-blue-600",   tabActiveBorder: "border-blue-500"   },
  { id: "call",    label: "Call",    icon: "call",    iconColor: "text-green-600",  iconBg: "bg-green-50",  tabActiveColor: "text-green-700",  tabActiveBorder: "border-green-500"  },
  { id: "email",   label: "Email",   icon: "email",   iconColor: "text-amber-600",  iconBg: "bg-amber-50",  tabActiveColor: "text-amber-700",  tabActiveBorder: "border-amber-500"  },
  { id: "task",    label: "Task",    icon: "task",    iconColor: "text-amber-500",  iconBg: "bg-amber-50",  tabActiveColor: "text-amber-600",  tabActiveBorder: "border-amber-500"  },
  { id: "meeting", label: "Meeting", icon: "meeting", iconColor: "text-purple-600", iconBg: "bg-purple-50", tabActiveColor: "text-purple-700", tabActiveBorder: "border-purple-500" },
];

const TYPE_ICONS = {
  note:    <FileText className="w-3.5 h-3.5" />,
  call:    <Phone className="w-3.5 h-3.5" />,
  email:   <Mail className="w-3.5 h-3.5" />,
  task:    <CheckSquare className="w-3.5 h-3.5" />,
  meeting: <Calendar className="w-3.5 h-3.5" />,
};

const CALL_OUTCOMES = [
  "No Answer",
  "No Answer + Voicemail Left",
  "Answered",
  "Wrong Number",
  "Call Back Later",
  "Not Interested",
  "Appointment Scheduled",
  "Follow-up Needed",
];

const CALL_DIRECTIONS = ["Outbound", "Incoming"];

export default function ActivityComposer({ lead, onActivityCreated }) {
  const [activeType, setActiveType] = useState("note");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [ownerEmails, setOwnerEmails] = useState({});

  // Call-specific state
  const [callOutcome, setCallOutcome] = useState("");
  const [callDirection, setCallDirection] = useState("Outbound");
  const [showCallFollowUp, setShowCallFollowUp] = useState(false);
  const [callFollowUpDate, setCallFollowUpDate] = useState("");
  const [callFollowUpTime, setCallFollowUpTime] = useState("");

  // Email-specific state
  const [emailSubject, setEmailSubject] = useState("");
  const [emailTemplate, setEmailTemplate] = useState("");
  const [emailGmailConnected, setEmailGmailConnected] = useState(true);
  const [emailSendError, setEmailSendError] = useState(null);
  const [autoSelectedTemplate, setAutoSelectedTemplate] = useState(false);

  // Task-specific state
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");

  // Meeting-specific state
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTime, setMeetingTime] = useState("");

  const { user: authUser } = useAuth();

  useEffect(() => {
    if (authUser) setCurrentUser(authUser);
    
    // Load owner emails from Railway Settings
    railwaySettings.get('owner_emails').then(res => {
      if (res?.value) setOwnerEmails(res.value);
    }).catch(() => {});
  }, [authUser]);

  // Auto-select email template when email tab opens
  useEffect(() => {
    if (activeType === "email" && !autoSelectedTemplate && lead.follow_up_type) {
      const templateKey = lead.follow_up_type === "Phone Call" ? "phone_call_reminder" : "appointment_reminder";
      const hasFollowUp = lead.follow_up_date && lead.follow_up_time;
      if (hasFollowUp && EMAIL_TEMPLATES[templateKey]) {
        setEmailTemplate(templateKey);
        const tmpl = EMAIL_TEMPLATES[templateKey];
        const rendered = renderTemplate(tmpl, buildEmailFields());
        setEmailSubject(rendered.subject);
        setContent(rendered.body);
        setAutoSelectedTemplate(true);
      }
    }
  }, [activeType, lead.follow_up_type, lead.follow_up_date, lead.follow_up_time, autoSelectedTemplate]);



  useEffect(() => {
    // Auto-show follow-up options for certain call outcomes
    const needsFollowUp = ["Follow-up Needed", "Call Back Later"].includes(callOutcome);
    setShowCallFollowUp(needsFollowUp);
  }, [callOutcome]);

  const handleSave = async () => {
    setSaving(true);

    try {
      // Railway activities API requires the Railway lead UUID (not external_ref).
      let railwayLeadId = lead.railway_id;
      if (!railwayLeadId) {
        try {
          const res = await railwayLeads.getByExternal(lead.id);
          railwayLeadId = res?.lead?.id;
        } catch { /* will skip create if no Railway lead */ }
      }
      let activity = null;
      if (railwayLeadId) {
        const res = await railwayActivities.create({
          lead_id: railwayLeadId,
          type: activeType,
          content: getContentForType(),
          author: currentUser?.full_name || "User",
          metadata: getMetadataForType(),
          source: "manual",
        });
        activity = res?.activity || null;
      }

      // Handle side effects based on activity type
      await handleActivitySideEffects();

      setSaving(false);
      onActivityCreated?.(activity);
      resetForm();
    } catch (e) {
      console.error("Error creating activity:", e);
      setSaving(false);
    }
  };

  const getContentForType = () => {
    switch (activeType) {
      case "note":
        return content;
      case "call":
        return content;
      case "email":
        return content;
      case "task":
        return taskTitle || "Task";
      case "meeting":
        return meetingTitle || "Meeting";
      default:
        return content;
    }
  };

  const getMetadataForType = () => {
    const meta = {};
    if (activeType === "call") {
      meta.call_outcome = callOutcome;
      meta.call_direction = callDirection;
    }
    if (activeType === "email") {
      meta.email_subject = emailSubject;
    }
    if (activeType === "task") {
      meta.task_due_date = taskDueDate;
    }
    if (activeType === "meeting") {
      meta.meeting_date = meetingDate;
      meta.meeting_time = meetingTime;
    }
    return meta;
  };

  const resolveOwnerEmail = (ownerName) => {
    if (!ownerName) return null;
    
    const normalized = String(ownerName).trim();
    const email = ownerEmails[normalized];
    return email || null;
  };

  const handleActivitySideEffects = async () => {
    // Handle email sending via Gmail (non-blocking — activity is already saved above)
    if (activeType === "email") {
      const fromEmail = resolveOwnerEmail(lead.assigned_rep);
      if (fromEmail && lead.email) {
        import('@/lib/railwayClient').then(({ railwayRequest }) => {
          railwayRequest('/gmail/send-email-via-account', {
            lead_id: lead.id,
            recipient_email: lead.email,
            subject: emailSubject,
            body: content,
            from_email: fromEmail,
          }).catch(e => {
            console.warn('[ActivityComposer] Gmail send unavailable:', e.message);
            setEmailSendError('Email saved to CRM but not sent via Gmail (integration unavailable).');
          });
        });
      }
    }

    // Handle call follow-up
    if (activeType === "call" && showCallFollowUp && callFollowUpDate && callFollowUpTime) {
      await railwayLeads.updateByExternal(lead.id, {
        follow_up_date: callFollowUpDate,
        follow_up_time: callFollowUpTime,
        follow_up_type: "Phone Call",
      });
    }

    // Handle appointment scheduling
    if (activeType === "call" && callOutcome === "Appointment Scheduled" && callFollowUpDate && callFollowUpTime) {
      await railwayLeads.updateByExternal(lead.id, {
        appointment_date: callFollowUpDate,
        appointment_time: callFollowUpTime,
        follow_up_date: callFollowUpDate,
        follow_up_time: callFollowUpTime,
        follow_up_type: "Meeting",
        status: "Appointment scheduled",
      });
    }

    // Handle meeting scheduling
    if (activeType === "meeting" && meetingDate && meetingTime) {
      await railwayLeads.updateByExternal(lead.id, {
        appointment_date: meetingDate,
        appointment_time: meetingTime,
        follow_up_date: meetingDate,
        follow_up_time: meetingTime,
        follow_up_type: "Meeting",
      });
    }

    // Handle task due date
    if (activeType === "task" && taskDueDate) {
      await railwayTasks.create({
        lead_id: lead.railway_id || lead.id,
        title: taskTitle || "Task",
        due_date: taskDueDate,
        status: "pending",
        assigned_to: currentUser?.full_name || "User",
      });
    }
  };

  const buildEmailFields = () => {
    const hasFollowUp = lead.follow_up_date && lead.follow_up_time;
    const date = hasFollowUp ? lead.follow_up_date : (lead.appointment_date || "TBD");
    const time = hasFollowUp ? lead.follow_up_time : (lead.appointment_time || "TBD");

    return {
      lead_name: `${lead.first_name} ${lead.last_name}`,
      company_name: "EC Construction Group",
      owner_name: lead.assigned_rep,
      owner_email: resolveOwnerEmail(lead.assigned_rep) || "contact@ecconstructiongroup.com",
      appointment_date: date,
      appointment_time: time,
      client_phone: lead.phone || "N/A",
      location: "Your property",
      property_address: lead.property_address || "the property",
      project_type: lead.project_type || "your project",
    };
  };

  const resetForm = () => {
    setContent("");
    setCallOutcome("");
    setCallDirection("Outbound");
    setCallFollowUpDate("");
    setCallFollowUpTime("");
    setEmailSubject("");
    setEmailTemplate("");
    setEmailSendError(null);
    setAutoSelectedTemplate(false);
    setTaskTitle("");
    setTaskDueDate("");
    setMeetingTitle("");
    setMeetingDate("");
    setMeetingTime("");
  };

  const isValid = () => {
    switch (activeType) {
      case "note":
      case "call":
      case "task":
        return content.trim() && (activeType !== "call" || callOutcome);
      case "email":
        return content.trim() && emailSubject.trim() && lead.assigned_rep && resolveOwnerEmail(lead.assigned_rep);
      case "meeting":
        return meetingTitle.trim() && meetingDate && meetingTime;
      default:
        return false;
    }
  };

  const activeTypeObj = ACTIVITY_TYPES.find(t => t.id === activeType);

  return (
    <div className="card-premium overflow-hidden">
      {/* Type Selector Tabs — full width, equal columns */}
      <div className="grid grid-cols-5 bg-slate-50 border-b border-slate-200">
        {ACTIVITY_TYPES.map((type) => {
          const isActive = activeType === type.id;
          return (
            <button
              key={type.id}
              onClick={() => setActiveType(type.id)}
              className={`btn-compact flex flex-row items-center justify-center gap-1 py-2.5 text-[11px] font-semibold transition-all border-b-2 ${
                isActive
                  ? `${type.tabActiveBorder} bg-white ${type.tabActiveColor}`
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-white/70"
              }`}
            >
              <span className={`leading-none ${isActive ? type.iconColor : ""}`}>{TYPE_ICONS[type.icon]}</span>
              <span className="leading-none">{type.label}</span>
            </button>
          );
        })}
      </div>

      {/* Form Content */}
      <div className="p-4 space-y-3">
        {/* Active type header */}
        <div className="flex items-center gap-2">
          <span className={`leading-none ${activeTypeObj?.iconColor}`}>{TYPE_ICONS[activeTypeObj?.icon]}</span>
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide leading-none">{activeTypeObj?.label}</h3>
        </div>

        {/* Note Form */}
        {activeType === "note" && (
          <div className="space-y-3">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write a note about this lead..."
              className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none multiline-text"
              rows={3}
            />
          </div>
        )}

        {/* Call Form */}
        {activeType === "call" && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Call Direction</label>
              <div className="grid grid-cols-2 gap-2">
                {CALL_DIRECTIONS.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setCallDirection(dir)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                      callDirection === dir
                        ? "bg-green-600 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {dir}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Call Outcome *</label>
              <select
                value={callOutcome}
                onChange={(e) => setCallOutcome(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500"
              >
                <option value="">— Select outcome</option>
                {CALL_OUTCOMES.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Call Notes *</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What happened during the call..."
                className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500 resize-none multiline-text"
                rows={3}
              />
            </div>

            {showCallFollowUp && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
                <p className="text-xs font-semibold text-green-900">
                  {callOutcome === "Appointment Scheduled" ? "Appointment Date/Time" : "Follow-up Date/Time"}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Date</label>
                    <input
                      type="date"
                      value={callFollowUpDate}
                      onChange={(e) => setCallFollowUpDate(e.target.value)}
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Time</label>
                    <AvailableTimePicker
                      value={callFollowUpTime}
                      onChange={setCallFollowUpTime}
                      date={callFollowUpDate}
                      ownerName={lead.assigned_rep}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Email Form */}
        {activeType === "email" && (
          <div className="space-y-3">
            {!emailGmailConnected && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700">
                  Gmail is not connected for your account. Emails will be saved in the CRM but not sent via Gmail.
                </p>
              </div>
            )}

            {emailSendError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">{emailSendError}</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">
                Use Template (optional)
                {autoSelectedTemplate && lead.follow_up_type && (
                  <span className="ml-2 text-green-600 font-semibold">
                    ✓ Auto-selected from Follow-up
                  </span>
                )}
              </label>
              <select
                value={emailTemplate}
                onChange={(e) => {
                  const templateKey = e.target.value;
                  setEmailTemplate(templateKey);
                  if (templateKey) {
                    const tmpl = EMAIL_TEMPLATES[templateKey];
                    if (tmpl) {
                      const rendered = renderTemplate(tmpl, buildEmailFields());
                      setEmailSubject(rendered.subject);
                      setContent(rendered.body);
                    }
                  }
                }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
              >
                <option value="">— Choose a template</option>
                {Object.entries(EMAIL_TEMPLATES).map(([key, tmpl]) => (
                  <option key={key} value={key}>{tmpl.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Email Subject *</label>
              <input
                type="text"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Email subject line..."
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Email Body *</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Email content..."
                className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none multiline-text"
                rows={3}
              />
            </div>

            {!lead.assigned_rep || lead.assigned_rep.trim() === '' ? (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs text-amber-700 font-semibold mb-1">No owner assigned to this lead</p>
                  <p className="text-[10px] text-amber-600">Assign a Contact Owner in the left panel to send emails from their address.</p>
                </div>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs font-semibold text-amber-900 mb-2">Send From:</p>
                <p className="text-sm text-amber-800 font-mono">
                  {resolveOwnerEmail(lead.assigned_rep) || `${lead.assigned_rep} (not configured)`}
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  {resolveOwnerEmail(lead.assigned_rep) 
                    ? "✓ Email will be sent from this address" 
                    : `⚠️ "${lead.assigned_rep}" not found in Owner Directory. Add it to Settings > Owner Directory.`}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Task Form */}
        {activeType === "task" && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Task Title *</label>
              <input
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="What needs to be done..."
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Due Date</label>
              <input
                type="date"
                value={taskDueDate}
                onChange={(e) => setTaskDueDate(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Notes</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Additional task details..."
                className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 resize-none multiline-text"
                rows={2}
              />
            </div>
          </div>
        )}

        {/* Meeting Form */}
        {activeType === "meeting" && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Meeting Title *</label>
              <input
                type="text"
                value={meetingTitle}
                onChange={(e) => setMeetingTitle(e.target.value)}
                placeholder="Meeting subject..."
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-2">Date *</label>
                <input
                  type="date"
                  value={meetingDate}
                  onChange={(e) => setMeetingDate(e.target.value)}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-2">Time *</label>
                <AvailableTimePicker
                  value={meetingTime}
                  onChange={setMeetingTime}
                  date={meetingDate}
                  ownerName={lead.assigned_rep}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-2">Notes</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Meeting agenda or details..."
                className="w-full border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none multiline-text"
                rows={2}
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !isValid()}
          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 active:scale-95 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <span className="leading-none">{TYPE_ICONS[activeTypeObj?.icon]}</span>
              Save {activeTypeObj?.label}
            </>
          )}
        </button>
      </div>
    </div>
  );
}