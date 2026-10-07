import { useState, useEffect, useCallback } from "react";
import * as railwaySignnow from "@/api/railway/signnow";
import { useToast } from "@/components/ui/use-toast";
import { Plus, Trash2, Loader2, Save, RefreshCw, AlertTriangle } from "lucide-react";

/**
 * SignNowFieldMappingPanel — admin UI for the CRM -> SignNow template
 * field-mapping layer (CRM STABILITY PHASE, completion pass, Section A4).
 *
 * This template's actual field names only become known once a document has
 * been prepared from it at least once (SignNow assigns a copy its own
 * field names/ids, distinct from the template — see lib/signnowClient.js's
 * getDocumentFields). Until then, live_fields is empty and an admin can
 * still type a field name manually (e.g. read from the SignNow template
 * editor directly).
 */
export default function SignNowFieldMappingPanel({ templateId, templateName }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [liveFields, setLiveFields] = useState([]);
  const [liveFieldsError, setLiveFieldsError] = useState(null);

  const load = useCallback(async () => {
    if (!templateId) return;
    setLoading(true);
    try {
      const [srcRes, mapRes] = await Promise.all([
        railwaySignnow.getCrmSources(),
        railwaySignnow.getFieldMappings(templateId),
      ]);
      setSources(srcRes?.sources || []);
      setMappings((mapRes?.mappings || []).map((m) => ({ ...m })));
      setLiveFields(mapRes?.live_fields || []);
      setLiveFieldsError(mapRes?.live_fields_error || null);
    } catch (e) {
      toast({ title: 'Failed to load field mappings', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [templateId, toast]);

  useEffect(() => { load(); }, [load]);

  const addRow = () => {
    setMappings([...mappings, { signnow_field_name: '', crm_source: sources[0]?.key || '', field_label: '', required: false }]);
  };

  const updateRow = (idx, patch) => {
    setMappings(mappings.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  };

  const removeRow = (idx) => {
    setMappings(mappings.filter((_, i) => i !== idx));
  };

  const save = async () => {
    const incomplete = mappings.some((m) => !m.signnow_field_name || !m.crm_source);
    if (incomplete) {
      toast({ title: 'Each row needs a SignNow field name and a CRM source', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const res = await railwaySignnow.setFieldMappings(templateId, mappings);
      setMappings(res.mappings);
      toast({ title: 'Field mapping saved', description: `${res.mappings.length} field(s) configured for ${templateName || 'this template'}.`, duration: 3000 });
    } catch (e) {
      toast({ title: 'Failed to save field mapping', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (!templateId) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-700">CRM Field Mapping — {templateName || templateId}</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Automatically fill this template's text fields from CRM lead/deal data — staff never re-type name, email, phone or address.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {liveFieldsError === 'signnow_not_configured' ? null : liveFieldsError ? (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> Could not read this template's live fields: {liveFieldsError}
        </div>
      ) : liveFields.length > 0 ? (
        <div className="text-xs text-slate-500 bg-slate-50 px-3 py-2 rounded border border-slate-100">
          Live fields found on the most recently prepared document: {liveFields.map((f) => f.name).join(', ')}
        </div>
      ) : (
        <div className="text-xs text-slate-400 bg-slate-50 px-3 py-2 rounded border border-slate-100">
          No document has been prepared from this template yet — field names below must be typed manually (from the SignNow template editor) until one has.
        </div>
      )}

      <div className="space-y-2">
        {mappings.map((m, idx) => (
          <div key={idx} className="flex items-center gap-2 border border-slate-100 rounded-lg p-2">
            <input
              type="text"
              value={m.signnow_field_name}
              onChange={(e) => updateRow(idx, { signnow_field_name: e.target.value })}
              placeholder="SignNow field name"
              list="signnow-live-fields"
              className="flex-1 min-w-0 border border-slate-200 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-orange"
            />
            <select
              value={m.crm_source}
              onChange={(e) => updateRow(idx, { crm_source: e.target.value, field_label: sources.find((s) => s.key === e.target.value)?.label || '' })}
              className="flex-1 min-w-0 border border-slate-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-orange"
            >
              {sources.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[10px] text-slate-500 whitespace-nowrap">
              <input type="checkbox" checked={!!m.required} onChange={(e) => updateRow(idx, { required: e.target.checked })} />
              Required
            </label>
            <button onClick={() => removeRow(idx)} className="text-slate-400 hover:text-red-600 flex-shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <datalist id="signnow-live-fields">
          {liveFields.map((f) => <option key={f.name} value={f.name} />)}
        </datalist>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={addRow} className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add Field
        </button>
        <button onClick={save} disabled={saving} className="flex items-center gap-2 bg-orange text-white px-4 py-1.5 text-xs font-bold rounded-lg hover:bg-orange/90 transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Mapping
        </button>
      </div>

      <p className="text-[10px] text-slate-400">
        Marking a field "Required" blocks preparing a contract from this template when that CRM data is missing — the user sees exactly what's missing before anything is created, instead of a half-filled contract.
      </p>
    </div>
  );
}
