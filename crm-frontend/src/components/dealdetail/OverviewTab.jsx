/**
 * OverviewTab — client info, project info, notes, pipeline stages.
 */
import { useState, useEffect } from "react";
import { Calendar, MapPin, User, FileText } from "lucide-react";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import { EditableInfoRow, EditableClientField } from "./EditableFields";
import ProjectTypeSelector from "@/components/ProjectTypeSelector";

const PIPELINE_STAGES = [
  "Sold / Estimate Approved",
  "Deposit Due",
  "Deposit Paid",
  "Work Scheduled",
  "Work Started",
  "Progress Payment Due",
  "Progress Payment Paid",
  "Final Payment Due",
  "Final Payment Paid",
  "Job Completed",
];

const STAGE_COLORS = {
  "Sold / Estimate Approved": { bg: "bg-blue-100",    text: "text-blue-700",    border: "border-blue-200" },
  "Deposit Due":              { bg: "bg-amber-100",   text: "text-amber-700",   border: "border-amber-200" },
  "Deposit Paid":             { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  "Work Scheduled":           { bg: "bg-sky-100",     text: "text-sky-700",     border: "border-sky-200" },
  "Work Started":             { bg: "bg-indigo-100",  text: "text-indigo-700",  border: "border-indigo-200" },
  "Progress Payment Due":     { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200" },
  "Progress Payment Paid":    { bg: "bg-teal-100",    text: "text-teal-700",    border: "border-teal-200" },
  "Final Payment Due":        { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200" },
  "Final Payment Paid":       { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200" },
  "Job Completed":            { bg: "bg-green-100",   text: "text-green-700",   border: "border-green-200" },
};

export default function OverviewTab({ deal, lead, updateField, setDeal, setLead, saving }) {
  const getFieldValue = (dealField, leadField) => dealField ?? leadField;
  const stageIndex = PIPELINE_STAGES.indexOf(deal.stage);
  const [notesDraft, setNotesDraft] = useState(deal.notes || "");
  useEffect(() => { setNotesDraft(deal.notes || ""); }, [deal.notes]);

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
      {/* Client Card */}
      <div className="card-premium p-4">
        <p className="typography-section-header mb-3">CLIENT</p>
        {lead ? (
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange to-amber-600 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-bold text-white">{lead.first_name?.[0]}{lead.last_name?.[0]}</span>
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <EditableClientField
                label="Name"
                value={`${lead.first_name || ""} ${lead.last_name || ""}`.trim()}
                onSave={async (fullName) => {
                  const [first, ...rest] = fullName.split(" ");
                  const last = rest.join(" ");
                  await railwayLeads.update(lead.id, { first_name: first, last_name: last || first });
                  setLead(prev => ({ ...prev, first_name: first, last_name: last || first }));
                  const newName = `${first} ${last || first}`;
                  await railwayDeals.update(deal.id, { name: newName });
                  setDeal(prev => ({ ...prev, name: newName }));
                }}
              />
              <EditableClientField
                label="Phone"
                value={lead.phone || ""}
                type="tel"
                onSave={async (phone) => {
                  await railwayLeads.update(lead.id, { phone });
                  setLead(prev => ({ ...prev, phone }));
                }}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-400 py-2">No lead linked to this deal.</p>
        )}
      </div>

      {/* Project Info */}
      <div className="card-premium p-4 space-y-3">
        <p className="typography-section-header">PROJECT INFO</p>
        <EditableInfoRow icon={MapPin} label="Address" value={getFieldValue(deal.property_address, lead?.property_address)}
          onSave={v => updateField("property_address", v)} saving={saving === "property_address"} />
        <div className="group cursor-pointer hover:bg-slate-50 p-1.5 rounded -mx-1.5 transition-colors">
          <ProjectTypeSelector
            value={getFieldValue(deal.project_type, lead?.project_type || lead?.job_type || lead?.job_types)}
            onSave={types => updateField("project_type", Array.isArray(types) ? types.join(", ") : types)}
            label="Project Type"
          />
        </div>
        <EditableInfoRow icon={User} label="Owner / Sales Rep" value={getFieldValue(deal.assigned_rep, lead?.assigned_rep)}
          onSave={v => updateField("assigned_rep", v)} saving={saving === "assigned_rep"} />
        <EditableInfoRow icon={Calendar} label="Sold Date" value={getFieldValue(deal.sold_date, lead?.sold_date)}
          type="date" onSave={v => updateField("sold_date", v)} saving={saving === "sold_date"} />
        <EditableInfoRow icon={FileText} label="Contract Signed" value={getFieldValue(deal.deposit_paid_date, lead?.signed_contract_date)}
          type="date" onSave={v => updateField("deposit_paid_date", v)} saving={saving === "deposit_paid_date"} />
      </div>

      {/* Notes */}
      <div className="card-premium p-4">
        <p className="typography-section-header mb-2">NOTES</p>
        <textarea
          value={notesDraft}
          onChange={e => setNotesDraft(e.target.value)}
          onBlur={() => {
            if (notesDraft !== (deal.notes || "")) updateField("notes", notesDraft);
          }}
          placeholder="Project notes…"
          rows={4}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 resize-none"
        />
      </div>

      {/* Pipeline Stages */}
      <div className="card-premium p-4">
        <p className="typography-section-header mb-3">PIPELINE</p>
        <div className="space-y-2">
          {PIPELINE_STAGES.map((stage, i) => {
            const isActive = deal.stage === stage;
            const isPast = i < stageIndex;
            const sc = STAGE_COLORS[stage];
            return (
              <button
                key={stage}
                onClick={async () => {
                  await updateField("stage", stage);
                  setDeal(prev => ({ ...prev, stage }));
                }}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border-2 text-sm font-semibold transition-all ${
                  isActive ? `${sc.bg} ${sc.text} ${sc.border} shadow-md`
                  : isPast ? "bg-slate-50 border-slate-200 text-slate-400"
                  : "bg-white border-slate-200 text-slate-600 hover:border-amber-300"
                }`}
              >
                <span>{stage}</span>
                {isActive && <span className="w-2 h-2 rounded-full bg-current"></span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}