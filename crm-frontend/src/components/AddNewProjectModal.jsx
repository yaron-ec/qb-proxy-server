import { useState, useEffect } from "react";
import * as railwaySettings from "@/api/railway/settings";
import * as railwayDeals from "@/api/railway/deals";
import { useNavigate } from "react-router-dom";
import { X, Loader2 } from "lucide-react";
import { CRMButton, CRMFieldLabel } from "@/components/crm";

const OWNERS = ["Yaron Drilevich", "Ethan Magen", "Michelle"];

const DEFAULT_JOB_TYPES = [
  "Roofing",
  "Kitchen remodel",
  "Bathroom remodel",
  "ADU / garage conversion",
  "Addition",
  "Landscaping / Hardscaping",
  "Pool",
  "Flooring",
  "Painting",
  "Windows",
  "Doors",
  "Other"
];

const getTodayDate = () => {
  const today = new Date();
  return today.toISOString().split("T")[0];
};

export default function AddNewProjectModal({ lead, currentDeal, onClose, onSuccess }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [jobTypes, setJobTypes] = useState(DEFAULT_JOB_TYPES);
  const [loadError, setLoadError] = useState(false);
  const [formData, setFormData] = useState({
    selected_job_types: [],
    amount: currentDeal?.amount ? Math.ceil((currentDeal.amount * 0.3)) : "",
    property_address: currentDeal?.property_address || lead?.property_address || "",
    assigned_rep: currentDeal?.assigned_rep || lead?.assigned_rep || "",
    sold_date: getTodayDate(),
    notes: "",
  });

  useEffect(() => {
    // Load job types from Settings like the Lead page does
    let timeoutId;
    const loadJobTypes = async () => {
      try {
        timeoutId = setTimeout(() => {
          setLoadError(true);
        }, 3000);

        const settings = await railwaySettings.get("app_lists");
        clearTimeout(timeoutId);

        if (settings && settings.value?.projectTypes) {
          setJobTypes(settings.value.projectTypes);
          setLoadError(false);
        } else {
          setLoadError(true);
        }
      } catch (e) {
        console.error("Failed to load job types:", e);
        setLoadError(true);
        clearTimeout(timeoutId);
      }
    };

    loadJobTypes();

    return () => clearTimeout(timeoutId);
  }, []);

  const handleJobTypeToggle = (type) => {
    setFormData(prev => ({
      ...prev,
      selected_job_types: prev.selected_job_types.includes(type)
        ? prev.selected_job_types.filter(t => t !== type)
        : [...prev.selected_job_types, type]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.selected_job_types.length) {
      alert("Please select at least one job type");
      return;
    }

    setLoading(true);
    try {
      const canonicalLeadId = lead.railway_id || lead.id;
      if (!canonicalLeadId) {
        alert("Cannot create deal: lead ID is missing. Please refresh the page and try again.");
        setLoading(false);
        return;
      }
      const projectName = formData.selected_job_types.join(", ");
      const newDeal = await railwayDeals.create({
        lead_id: canonicalLeadId,
        name: projectName,
        project_type: projectName,
        amount: parseFloat(formData.amount) || 0,
        property_address: formData.property_address,
        assigned_rep: formData.assigned_rep,
        sold_date: formData.sold_date ? new Date(formData.sold_date).toISOString() : new Date().toISOString(),
        notes: formData.notes,
        stage: "Sold / Estimate Approved",
        pipeline: currentDeal?.pipeline || "Default Pipeline",
      });

      const created = newDeal?.deal || newDeal;
      if (!created?.id) throw new Error("Server did not return a deal ID");
      onSuccess?.(created);
      navigate(`/deals/${created.id}`);
    } catch (e) {
      console.error("Failed to create deal:", e);
      alert("Failed to create project: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
          <h2 className="text-lg font-bold text-slate-900">Add New Project</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
         <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-6 py-4">
           {/* Job Types - Same UI as Lead page */}
           <div className="mb-6">
             <div className="flex items-center justify-between mb-2">
               <CRMFieldLabel className="block">Job Type *</CRMFieldLabel>
               {loadError && <span className="text-[10px] text-red-500 font-semibold">Using defaults</span>}
             </div>

             {/* Display selected as badges */}
             {formData.selected_job_types.length > 0 ? (
               <div className="flex flex-wrap gap-1.5 mb-3">
                 {formData.selected_job_types.map(type => (
                   <span key={type} className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-900 px-2 py-1 rounded">
                     {type}
                     <button
                       type="button"
                       onClick={() => handleJobTypeToggle(type)}
                       className="ml-0.5 hover:opacity-70"
                     >
                       ×
                     </button>
                   </span>
                 ))}
               </div>
             ) : null}

             {/* Checkboxes - Limited height with scroll */}
             <div className="border border-slate-200 rounded-lg p-3 space-y-2 max-h-56 overflow-y-auto bg-white">
               {jobTypes.map(type => (
                 <label key={type} className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded cursor-pointer transition-colors">
                   <input
                     type="checkbox"
                     checked={formData.selected_job_types.includes(type)}
                     onChange={() => handleJobTypeToggle(type)}
                     disabled={loading}
                     className="w-4 h-4 rounded border-slate-300 accent-amber-600"
                   />
                   <span className="text-sm text-slate-700">{type}</span>
                 </label>
               ))}
             </div>
           </div>

           {/* 2-Column Layout */}
           <div className="grid grid-cols-2 gap-4 mb-6">
             {/* Contract Amount */}
             <div>
               <CRMFieldLabel className="block mb-1.5">Contract Amount ($)</CRMFieldLabel>
               <input
                 type="number"
                 value={formData.amount}
                 onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                 placeholder="0"
                 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                 disabled={loading}
               />
             </div>

             {/* Sold Date */}
             <div>
               <CRMFieldLabel className="block mb-1.5">Sold Date</CRMFieldLabel>
               <input
                 type="date"
                 value={formData.sold_date}
                 onChange={(e) => setFormData({ ...formData, sold_date: e.target.value })}
                 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                 disabled={loading}
               />
             </div>

             {/* Project Address */}
             <div>
               <CRMFieldLabel className="block mb-1.5">Project Address</CRMFieldLabel>
               <input
                 type="text"
                 value={formData.property_address}
                 onChange={(e) => setFormData({ ...formData, property_address: e.target.value })}
                 placeholder={lead?.property_address || "Enter address"}
                 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                 disabled={loading}
               />
             </div>

             {/* Owner */}
             <div>
               <CRMFieldLabel className="block mb-1.5">Owner</CRMFieldLabel>
               <select
                 value={formData.assigned_rep}
                 onChange={(e) => setFormData({ ...formData, assigned_rep: e.target.value })}
                 className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                 disabled={loading}
               >
                 <option value="">Select owner</option>
                 {OWNERS.map(owner => (
                   <option key={owner} value={owner}>{owner}</option>
                 ))}
               </select>
             </div>
           </div>

           {/* Notes - Full Width */}
           <div className="mb-4">
             <CRMFieldLabel className="block mb-1.5">Notes</CRMFieldLabel>
             <textarea
               value={formData.notes}
               onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
               placeholder="Project notes"
               rows={3}
               className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 resize-none"
               disabled={loading}
             />
           </div>
         </form>

         {/* Sticky Footer */}
         <div className="border-t border-slate-200 bg-white px-6 py-4 flex gap-2 flex-shrink-0">
           <button
             type="button"
             onClick={onClose}
             className="flex-1 px-4 py-2 text-sm font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
             disabled={loading}
           >
             Cancel
           </button>
           <CRMButton
             type="submit"
             onClick={handleSubmit}
             className="flex-1 flex items-center justify-center gap-2"
             disabled={loading || formData.selected_job_types.length === 0}
           >
             {loading && <Loader2 className="w-4 h-4 animate-spin" />}
             {loading ? "Creating..." : "Create Project"}
           </CRMButton>
         </div>
       </div>
     </div>
   );
  }