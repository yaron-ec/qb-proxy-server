/**
 * ProjectTab — Handoff estimates, work dates, project status.
 */
import { Calendar, Briefcase } from "lucide-react";
import HandoffEstimatesPanel from "@/components/HandoffEstimatesPanel";
import { EditableInfoRow } from "./EditableFields";

export default function ProjectTab({ deal, lead, updateField, setLead, saving }) {
  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5">
      {/* Handoff Estimates */}
      <div>
        <p className="typography-section-header mb-2">HANDOFF ESTIMATE</p>
        <div className="card-premium overflow-hidden">
          <HandoffEstimatesPanel lead={lead} onLeadUpdate={setLead} />
        </div>
      </div>

      {/* Project Schedule */}
      <div className="card-premium p-4 space-y-3">
        <p className="typography-section-header">PROJECT SCHEDULE</p>
        <EditableInfoRow icon={Calendar} label="Work Start Date" value={deal.work_start_date}
          type="date" onSave={v => updateField("work_start_date", v)} saving={saving === "work_start_date"} />
        <EditableInfoRow icon={Calendar} label="Work End Date" value={deal.work_end_date}
          type="date" onSave={v => updateField("work_end_date", v)} saving={saving === "work_end_date"} />
        <EditableInfoRow icon={Briefcase} label="Project Type" value={deal.project_type || lead.project_type}
          onSave={v => updateField("project_type", v)} saving={saving === "project_type"} />
      </div>
    </div>
  );
}