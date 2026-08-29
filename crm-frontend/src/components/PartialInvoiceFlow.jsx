import { useState, useEffect } from "react";
import { invoices as railwayInvoices, leads as railwayLeads } from "@/api/railway";
import {
  ChevronDown, ChevronRight, Plus, Loader2, AlertTriangle, Check,
  Receipt, ExternalLink, Trash2, Mail, MailX, RotateCw, Pencil
} from "lucide-react";
import RightPanelSection from "@/components/RightPanelSection";
import RightPanelInfoNotice from "@/components/RightPanelInfoNotice";

export default function PartialInvoiceFlow({ lead, onLeadUpdate, dealId }) {
  const [collapsed, setCollapsed] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showProjectTotalEdit, setShowProjectTotalEdit] = useState(false);

  useEffect(() => {
    loadInvoices();
  }, [lead.id]);

  const loadInvoices = async () => {
    try {
      // Sale-scoped: when dealId is provided, show only this Sale's invoices.
      const params = { lead_id: lead.railway_id };
      if (dealId) params.deal_id = dealId;
      const res = await railwayInvoices.list(params);
      const data = res.items || [];
      setInvoices(data.sort((a, b) => new Date(b.created_date || b.created_at) - new Date(a.created_date || a.created_at)));
    } catch (e) {
      console.error("Error loading invoices:", e);
    }
  };

  const calculateBalance = () => {
    const projectTotal = lead.estimated_value || 0;
    const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.payment_received || 0), 0);
    const balanceDue = projectTotal - totalInvoiced; // כמה עוד צריך לחייב
    const totalLeft = totalInvoiced - totalPaid; // כמה כסף עדיין לא שולם
    return {
      projectTotal,
      totalInvoiced,
      totalPaid,
      totalLeft,
      balanceDue,
    };
  };

  const handleProjectTotalChange = async (newValue) => {
    await railwayLeads.updateByExternal(lead.id, { estimated_value: parseFloat(newValue) });
    onLeadUpdate({ ...lead, estimated_value: parseFloat(newValue) });
  };

  const balance = calculateBalance();
  const isSold = lead.status === "Sold";

  if (!isSold) {
    return (
      <div className="border-t border-slate-100 px-4 py-3">
        <RightPanelInfoNotice
          title="Invoicing available only for Sold leads"
          description="Once you mark this lead as Sold, you'll be able to create and send invoices."
          type="info"
        />
      </div>
    );
  }

  return (
    <>
      {showProjectTotalEdit && (
        <EditableProjectTotal 
          value={balance.projectTotal} 
          onSave={(val) => {
            handleProjectTotalChange(val);
            setShowProjectTotalEdit(false);
          }}
          onClose={() => setShowProjectTotalEdit(false)}
        />
      )}
      <RightPanelSection
      title="Invoices"
      count={invoices.length}
      collapsed={collapsed}
      onCollapse={() => setCollapsed(!collapsed)}
    >
      <div className="space-y-3">
          {/* Balance Summary - KPI Cards */}
          <div className="grid grid-cols-2 gap-2">
            {/* Project Total - Editable */}
            <div
              className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm group cursor-pointer hover:shadow-md transition-all"
              onClick={() => setShowProjectTotalEdit(true)}
            >
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Project Total</p>
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-900">${balance.projectTotal.toLocaleString("en-US", { minimumFractionDigits: 0 })}</p>
                <Pencil className="w-3 h-3 text-slate-300 group-hover:text-amber-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Total Invoiced</p>
              <p className="text-sm font-bold text-slate-900">${balance.totalInvoiced.toLocaleString("en-US", { minimumFractionDigits: 0 })}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Total Left</p>
              <p className="text-sm font-bold text-slate-900">${balance.totalLeft.toLocaleString("en-US", { minimumFractionDigits: 0 })}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
              <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Balance Due</p>
              <p className={`text-sm font-bold ${balance.balanceDue > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                ${balance.balanceDue.toLocaleString("en-US", { minimumFractionDigits: 0 })}
              </p>
            </div>
          </div>


      </div>
    </RightPanelSection>
    </>
  );
}

function EditableProjectTotal({ value, onSave, onClose }) {
  const [editValue, setEditValue] = useState(String(value || 0));

  const handleSave = async () => {
    await onSave(editValue);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg p-4 w-80 shadow-xl" onClick={e => e.stopPropagation()}>
        <p className="text-sm font-bold text-slate-900 mb-3">Set Project Total</p>
        <input
          type="number"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-orange/50"
          autoFocus
        />
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-sm font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-3 py-2 text-sm font-semibold text-white bg-orange rounded-lg hover:bg-orange/90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}