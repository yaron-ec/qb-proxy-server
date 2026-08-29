import { useState, useEffect } from "react";
import * as railwayApi from "@/lib/railwayApi";
import { apiCall } from "@/api/railway/client";
import { Plus, Trash2, Edit2, Check, X } from "lucide-react";

const CONTRACT_TYPES = [
  'Main Contract',
  'Estimate Agreement',
  'Change Order',
  'Payment Agreement',
  'NDA',
  'Service Agreement',
  'Other',
];

export default function SignNowTemplateManager() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [formData, setFormData] = useState({
    template_id: '',
    template_name: '',
    contract_type: 'Main Contract',
    description: '',
  });

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const res = await apiCall('/api/v1/signnow/template-mappings?sort=-created_date&limit=100', { method: 'GET' }).then(r => r.items || []).catch(() => []);
      setTemplates(res);
    } catch (e) {
      console.error('Error loading templates:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!formData.template_id || !formData.template_name) {
      alert('Template ID and Name are required');
      return;
    }

    try {
      const meResp = await railwayApi.me();
      await apiCall('/api/v1/signnow/template-mappings', {
        method: 'POST',
        body: { ...formData, created_by: meResp.user?.email || 'admin' },
      });
      setTemplates(await apiCall('/api/v1/signnow/template-mappings?sort=-created_date&limit=100', { method: 'GET' }).then(r => r.items || []).catch(() => []));
      setAdding(false);
      setFormData({
        template_id: '',
        template_name: '',
        contract_type: 'Main Contract',
        description: '',
      });
    } catch (e) {
      console.error('Error adding template:', e);
      alert('Failed to add template');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this template mapping?')) return;
    try {
      await apiCall(`/api/v1/signnow/template-mappings/${id}`, { method: 'DELETE' });
      setTemplates(templates.filter(t => t.id !== id));
    } catch (e) {
      console.error('Error deleting template:', e);
    }
  };

  if (loading) {
    return <div className="p-4 text-center text-slate-500">Loading templates...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-slate-900">SignNow Template Mapping</h3>
        <button
          onClick={() => setAdding(!adding)}
          className="flex items-center gap-2 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Template
        </button>
      </div>

      {/* Add Form */}
      {adding && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Template ID *</label>
            <input
              type="text"
              value={formData.template_id}
              onChange={e => setFormData({ ...formData, template_id: e.target.value })}
              placeholder="From SignNow (e.g., template_12345)"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Template Name *</label>
            <input
              type="text"
              value={formData.template_name}
              onChange={e => setFormData({ ...formData, template_name: e.target.value })}
              placeholder="Human-readable name"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Contract Type</label>
            <select
              value={formData.contract_type}
              onChange={e => setFormData({ ...formData, contract_type: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            >
              {CONTRACT_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={e => setFormData({ ...formData, description: e.target.value })}
              placeholder="What this template is used for"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              rows={2}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setAdding(false)}
              className="px-3 py-1.5 text-slate-700 hover:bg-slate-200 rounded-lg transition-colors text-sm font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <Check className="w-4 h-4" /> Save
            </button>
          </div>
        </div>
      )}

      {/* Template List */}
      {templates.length === 0 ? (
        <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-lg border border-slate-200">
          <p className="text-sm">No templates configured yet</p>
          <p className="text-xs mt-1">Add templates to prevent incorrect template assignment</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map(template => (
            <div key={template.id} className="bg-white border border-slate-200 rounded-lg p-4 flex items-start justify-between hover:shadow-sm transition-shadow">
              <div className="flex-1">
                <h4 className="font-semibold text-slate-900">{template.template_name}</h4>
                <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                  <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{template.template_id}</span>
                  <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded font-medium">{template.contract_type}</span>
                  {template.usage_count > 0 && (
                    <span>Used {template.usage_count}x{template.last_used_at && ` (${new Date(template.last_used_at).toLocaleDateString()})`}</span>
                  )}
                </div>
                {template.description && (
                  <p className="text-xs text-slate-600 mt-2">{template.description}</p>
                )}
              </div>
              <button
                onClick={() => handleDelete(template.id)}
                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors flex-shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Info Box */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
        <p className="font-medium mb-1">ℹ️ Template Management</p>
        <p>Map your SignNow templates to contract types. This prevents incorrect template assignment and tracks usage across the sales pipeline.</p>
      </div>
    </div>
  );
}