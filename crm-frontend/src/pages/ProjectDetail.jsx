import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { apiCall } from "@/api/railway/client";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { ArrowLeft, Save, Trash2, Upload, X } from "lucide-react";

const STATUSES = ["Pre-Construction", "In Progress", "On Hold", "Completed", "Cancelled"];

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "", client_name: "", client_email: "", client_phone: "",
    property_address: "", project_type: "", status: "Pre-Construction",
    start_date: "", estimated_completion: "", contract_value: "",
    contract_signed: false, assigned_pm: "", scope_summary: "", notes: "",
    photo_urls: [],
  });
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!isNew) {
      apiCall(`/api/v1/deals/${id}`, { method: 'GET' }).then(data => {
        setProject(data);
        setForm(data);
        setLoading(false);
      });
    }
  }, [id]);

  const save = async () => {
    setSaving(true);
    try {
      if (isNew) {
        if (!form.lead_id) {
          alert('Cannot create project: lead_id is required. Projects must be created from a lead.');
          return;
        }
        const created = await apiCall('/api/v1/deals', { method: 'POST', body: form });
        const deal = created?.deal || created;
        if (!deal?.id) throw new Error('Server did not return a deal ID');
        navigate(`/deals/${deal.id}`);
      } else {
        await apiCall(`/api/v1/deals/${id}`, { method: 'PUT', body: form });
      }
    } catch (e) {
      console.error('[ProjectDetail] save error:', e);
      const msg = e?.data?.details || e?.data?.error || e?.message || 'Unknown error';
      alert('Failed to save project: ' + msg);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (confirm("Delete this project?")) {
      await apiCall(`/api/v1/deals/${id}`, { method: 'DELETE' });
      navigate("/projects");
    }
  };

  const f = (k) => form[k] ?? "";
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const uploadPhoto = async (file) => {
    setUploading(true);
    const { url: file_url } = await uploadFileToStorage(file);
    set("photo_urls", [...(form.photo_urls || []), file_url]);
    setUploading(false);
  };

  const removePhoto = (index) => {
    set("photo_urls", (form.photo_urls || []).filter((_, i) => i !== index));
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-muted border-t-orange rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8 border-b border-border pb-6">
        <Link to="/projects" className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground hover:text-orange mb-4 transition-colors">
          <ArrowLeft className="w-3 h-3" /> Back to Projects
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-black text-midnight uppercase tracking-tight">
              {isNew ? "New Project" : (form.name || "Project")}
            </h1>
            {!isNew && form.property_address && (
              <div className="text-sm font-mono text-muted-foreground mt-1">{form.property_address}</div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-orange text-white px-4 py-2.5 text-xs font-bold tracking-widest uppercase hover:bg-orange/90 transition-colors disabled:opacity-50">
              <Save className="w-3 h-3" />
              {saving ? "Saving..." : "Save"}
            </button>
            {!isNew && (
              <button onClick={remove}
                className="flex items-center gap-2 bg-white border border-destructive text-destructive px-4 py-2.5 text-xs font-bold uppercase tracking-widest hover:bg-destructive hover:text-white transition-colors">
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Section title="Client Information">
            <div className="grid grid-cols-2 gap-4">
              <PField label="Client Name *" value={f("client_name")} onChange={v => set("client_name", v)} />
              <PField label="Client Email" value={f("client_email")} onChange={v => set("client_email", v)} />
              <PField label="Client Phone" value={f("client_phone")} onChange={v => set("client_phone", v)} />
              <div className="col-span-2">
                <PField label="Property Address" value={f("property_address")} onChange={v => set("property_address", v)} />
              </div>
            </div>
          </Section>

          <Section title="Project Details">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <PField label="Project Name *" value={f("name")} onChange={v => set("name", v)} />
              </div>
              <PSelect label="Project Type" value={f("project_type")} onChange={v => set("project_type", v)}
                options={["Kitchen remodel","Bathroom remodel","ADU / garage conversion","Addition","Full-home remodel","Exterior / hardscape","Commercial tenant improvement","Other"]} />
              <PField label="Contract Value ($)" value={f("contract_value")} onChange={v => set("contract_value", parseFloat(v) || "")} type="number" />
              <PField label="Start Date" value={f("start_date")} onChange={v => set("start_date", v)} type="date" />
              <PField label="Est. Completion" value={f("estimated_completion")} onChange={v => set("estimated_completion", v)} type="date" />
              <div className="col-span-2">
                <PTextArea label="Scope Summary" value={f("scope_summary")} onChange={v => set("scope_summary", v)} />
              </div>
            </div>
          </Section>

          <Section title="Internal Notes">
            <PTextArea label="Notes" value={f("notes")} onChange={v => set("notes", v)} rows={4} />
          </Section>
        </div>

        <div className="space-y-4">
          <section className="bg-white border border-border p-5">
            <h2 className="text-[10px] font-black tracking-widest uppercase text-midnight mb-4 pb-2 border-b border-border">Status</h2>
            <PSelect label="Project Status" value={f("status")} onChange={v => set("status", v)} options={STATUSES} />
            <div className="mt-4">
              <PField label="Assigned PM" value={f("assigned_pm")} onChange={v => set("assigned_pm", v)} placeholder="pm@company.com" />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <input type="checkbox" id="signed" checked={!!form.contract_signed} onChange={e => set("contract_signed", e.target.checked)} className="w-4 h-4 accent-orange" />
              <label htmlFor="signed" className="text-xs font-mono font-bold tracking-wider uppercase text-foreground">Contract Signed</label>
            </div>
          </section>

          {!isNew && (
            <section className="bg-white border border-border p-5">
              <h2 className="text-[10px] font-black tracking-widest uppercase text-midnight mb-3">Meta</h2>
              <div className="space-y-2 text-[11px] font-mono text-muted-foreground">
                <div className="flex justify-between">
                  <span className="uppercase tracking-wider">Created</span>
                  <span className="text-foreground font-bold">{new Date(project?.created_date).toLocaleDateString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="uppercase tracking-wider">QBO Synced</span>
                  <span className={project?.qbo_synced ? "text-emerald-600 font-bold" : "text-muted-foreground font-bold"}>
                    {project?.qbo_synced ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            </section>
          )}

          <section className="bg-white border border-border p-5">
            <h2 className="text-[10px] font-black tracking-widest uppercase text-midnight mb-3">Project Photos</h2>
            <div className="border-2 border-dashed border-border p-4 text-center hover:border-orange transition-colors cursor-pointer">
              <Upload className="w-5 h-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-[10px] font-mono text-muted-foreground mb-2">Upload photos</p>
              <input type="file" multiple accept="image/*" className="hidden" id="photo-upload"
                onChange={e => Array.from(e.target.files).forEach(uploadPhoto)} />
              <label htmlFor="photo-upload" className="cursor-pointer text-[10px] font-bold tracking-widest uppercase text-orange hover:underline">
                {uploading ? "Uploading..." : "Choose Files"}
              </label>
            </div>
            {form.photo_urls?.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground mb-2">{form.photo_urls.length} Photo{form.photo_urls.length !== 1 ? "s" : ""}</div>
                <div className="grid grid-cols-2 gap-2">
                  {form.photo_urls.map((url, i) => (
                    <div key={i} className="relative group">
                      <img src={url} alt={`Photo ${i + 1}`} className="w-full h-20 object-cover rounded border border-border" />
                      <button
                        onClick={() => removePhoto(i)}
                        className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                        <X className="w-4 h-4 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="bg-white border border-border p-6">
      <h2 className="text-xs font-black tracking-widest uppercase text-midnight mb-5 pb-3 border-b border-border">{title}</h2>
      {children}
    </section>
  );
}

function PField({ label, value, onChange, type = "text", placeholder }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground mb-1">{label}</label>
      <input type={type} className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors"
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function PTextArea({ label, value, onChange, rows = 3 }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground mb-1">{label}</label>
      <textarea rows={rows} className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors resize-none"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function PSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground mb-1">{label}</label>
      <select className="w-full border border-border bg-concrete px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange transition-colors"
        value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}