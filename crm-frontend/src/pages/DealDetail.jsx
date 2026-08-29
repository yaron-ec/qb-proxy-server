import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayInvoices from "@/api/railway/invoices";
import { TrendingUp, LayoutDashboard, DollarSign, FileText, Briefcase, Clock, PieChart } from "lucide-react";
import AddNewProjectModal from "@/components/AddNewProjectModal";
import { TabBar } from "@/components/DesignSystem";
import { deriveStageFromPayments } from "@/components/DealPaymentPanel";
import DealHeader from "@/components/dealdetail/DealHeader";
import OverviewTab from "@/components/dealdetail/OverviewTab";
import FinancialTab from "@/components/dealdetail/FinancialTab";
import FinancialsTab from "@/components/financials/FinancialsTab";
import DocumentsTab from "@/components/dealdetail/DocumentsTab";
import ProjectTab from "@/components/dealdetail/ProjectTab";
import ActivityTab from "@/components/dealdetail/ActivityTab";

const DEAL_TO_LEAD_MAP = {
  assigned_rep: "assigned_rep",
  project_type: "project_type",
  property_address: "property_address",
  sold_date: "sold_date",
  notes: "notes",
  amount: "estimated_value",
};

const TABS = [
  { id: "overview",   label: "Overview",   icon: LayoutDashboard },
  { id: "financial",  label: "Financial",  icon: DollarSign },
  { id: "financials", label: "Financials", icon: PieChart },
  { id: "documents",  label: "Documents",  icon: FileText },
  { id: "project",    label: "Project",    icon: Briefcase },
  { id: "activity",   label: "Activity",   icon: Clock },
];

export default function DealDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [deal, setDeal] = useState(null);
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");

  // Refresh deal + lead data after QB actions
  const refreshLead = async () => {
    try {
      const d = await railwayDeals.get(id);
      const leadData = d.lead_id ? await railwayLeads.get(d.lead_id).catch(() => null) : null;
      if (leadData) setLead(leadData);
      if (d) setDeal(d);
    } catch { /* non-critical */ }
  };

  // Load deal — Railway API: deal + lead + invoices in parallel
  useEffect(() => {
    (async () => {
      try {
        const d = await railwayDeals.get(id);
        const leadData = d.lead_id ? await railwayLeads.get(d.lead_id).catch(() => null) : null;
        let invoices = [];
        if (d.lead_id) {
          try {
            const invRes = await railwayInvoices.list({ lead_id: d.lead_id });
            invoices = invRes.items || [];
          } catch {}
        }
        const suggested = deriveStageFromPayments(d);
        let finalDeal = d;
        if (suggested && !d.stage_override && d.stage !== suggested) {
          try { finalDeal = await railwayDeals.update(id, { stage: suggested }); } catch {}
        }
        setDeal(finalDeal);
        setLead(leadData);
        setInvoices(invoices.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)));
        setLoading(false);
      } catch {
        setDeal(null);
        setLoading(false);
      }
    })();
  }, [id]);

  // Reload invoices when deal changes (no Base44 realtime — polling on tab switch)
  useEffect(() => {
    if (!deal?.lead_id) return;
    const loadInvoices = async () => {
      try {
        const invRes = await railwayInvoices.list({ lead_id: deal.lead_id });
        const invs = invRes.items || [];
        setInvoices(invs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)));
      } catch { /* non-critical */ }
    };
    loadInvoices();
  }, [deal?.lead_id]);

  const updateField = async (field, value) => {
    setDeal(prev => ({ ...prev, [field]: value }));
    setSaving(field);
    try {
      const updatedDeal = await railwayDeals.update(id, { [field]: value });
      setDeal(updatedDeal);
      // If this field maps to a lead field, update the lead too
      const leadField = DEAL_TO_LEAD_MAP[field];
      if (leadField && lead?.id) {
        try {
          const updatedLead = await railwayLeads.update(lead.id, { [leadField]: value });
          setLead(updatedLead);
        } catch {}
      }
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 2000);
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteDeal = async () => {
    if (!window.confirm("Delete this project only?\n\n(This will not affect the customer or other projects)")) return;
    try {
      await railwayDeals.remove(id);
      navigate("/deals");
    } catch (err) {
      alert("Failed to delete deal: " + err.message);
    }
  };

  const handleAddProjectSuccess = () => {
    setShowAddProject(false);
    // Multi-deal detection via Railway API
    railwayDeals.list({ lead_id: lead.id }).then(res => {
      const deals = res.items || [];
      if (deals.length > 1) {
        const newestDeal = deals.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
        if (newestDeal.id !== id) navigate(`/deals/${newestDeal.id}`);
      }
    }).catch(() => {});
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-amber-500 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!deal || !lead) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-slate-50 gap-3">
        <TrendingUp className="w-12 h-12 text-slate-300" />
        <p className="text-base font-semibold text-slate-600">Deal not found</p>
      </div>
    );
  }

  return (
    <>
      {showAddProject && (
        <AddNewProjectModal lead={lead} currentDeal={deal} onClose={() => setShowAddProject(false)} onSuccess={handleAddProjectSuccess} />
      )}
      <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
        <DealHeader deal={deal} lead={lead} onAddProject={() => setShowAddProject(true)} onDeleteDeal={handleDeleteDeal} />
        <TabBar tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />
        <div className="flex-1 overflow-y-auto">
          {activeTab === "overview" && (
            <OverviewTab deal={deal} lead={lead} updateField={updateField} setDeal={setDeal} setLead={setLead} saving={saving} />
          )}
          {activeTab === "financial" && (
            <FinancialTab
              deal={deal} lead={lead} invoices={invoices}
              setDeal={setDeal} setLead={setLead} refreshLead={refreshLead}
              editingField={editingField} setEditingField={setEditingField}
              savedMsg={savedMsg} setSavedMsg={setSavedMsg}
            />
          )}
          {activeTab === "financials" && (
            <FinancialsTab deal={deal} lead={lead} invoices={invoices} setDeal={setDeal} />
          )}
          {activeTab === "documents" && <DocumentsTab lead={lead} setLead={setLead} />}
          {activeTab === "project" && <ProjectTab deal={deal} lead={lead} updateField={updateField} setLead={setLead} saving={saving} />}
          {activeTab === "activity" && <ActivityTab />}
        </div>
      </div>
    </>
  );
}