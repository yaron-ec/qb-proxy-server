/**
 * ActivityTab — Deal Activity as a real construction project timeline.
 *
 * This is PROJECT HISTORY (Sale -> Contract -> Execution -> Financial/
 * Document events -> Completion), not a generic call/email/note feed.
 * Every event is fetched pre-derived from GET /api/v1/deals/:id/timeline
 * (lib/dealTimeline.js on the backend) — this component only renders it and
 * lets a user upload the signed Completion Form. No event is ever created
 * here directly, so simply viewing/reloading this tab can never duplicate
 * anything.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Flag, FileSignature, DollarSign, RefreshCw, TrendingUp, FileText,
  CheckCircle2, Upload, ExternalLink, Download, Loader2, AlertCircle, Clock,
} from "lucide-react";
import * as railwayDealTimeline from "@/api/railway/dealTimeline";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { fmtMoney, fmtDate, fmtBusinessDate } from "@/lib/formatters";
import { EmptyState } from "@/components/DesignSystem";

const CATEGORY_META = {
  milestone:    { label: "Milestone",    icon: Flag,          color: "bg-blue-100 text-blue-700 border-blue-200" },
  contract:     { label: "Contract",     icon: FileSignature, color: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  payment:      { label: "Payment",      icon: DollarSign,    color: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  change_order: { label: "Change Order", icon: RefreshCw,     color: "bg-orange-100 text-orange-700 border-orange-200" },
  financial:    { label: "Financial",    icon: TrendingUp,    color: "bg-slate-100 text-slate-600 border-slate-200" },
  document:     { label: "Document",     icon: FileText,      color: "bg-sky-100 text-sky-700 border-sky-200" },
  completion:   { label: "Completion",   icon: CheckCircle2,  color: "bg-green-100 text-green-700 border-green-200" },
};

const FILTERS = [
  { id: "all",        label: "All",        categories: null },
  { id: "milestones", label: "Milestones", categories: ["milestone", "contract", "completion"] },
  { id: "financial",  label: "Financial",  categories: ["payment", "change_order", "financial"] },
  { id: "documents",  label: "Documents",  categories: ["document"] },
];

const ACCEPTED_COMPLETION_FORM_TYPES = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

function isImage(fileType) {
  return typeof fileType === "string" && fileType.startsWith("image/");
}
function isPdf(fileType, fileName) {
  if (fileType === "application/pdf") return true;
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".pdf");
}

// event.dateKind ('date' | 'instant') tells us whether event.date is a
// literal calendar date (sold_date, work_start_date, a payment milestone —
// no timezone conversion, ever) or a real instant (a signature, an upload,
// an activity log entry — correctly converted to the CRM's Pacific business
// timezone). Mixing these up is exactly the bug that made "Deal Sold"
// disagree with Deal Overview by one day — see lib/dealTimeline.js.
function formatEventDate(event) {
  return event.dateKind === 'date' ? fmtBusinessDate(event.date) : fmtDate(event.date);
}

function TimelineEvent({ event, previewOpen, onTogglePreview }) {
  const meta = CATEGORY_META[event.category] || CATEGORY_META.financial;
  const Icon = meta.icon;
  const doc = event.document;
  const img = doc && isImage(doc.fileType);
  const pdf = doc && isPdf(doc.fileType, doc.fileName);

  return (
    <li className="relative ml-4">
      <span className="absolute -left-[23px] top-1 w-3 h-3 rounded-full bg-white border-2 border-amber-500" />
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border ${meta.color}`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800">{event.title}</p>
            {(event.by || event.detail) && (
              <p className="text-xs text-slate-400 truncate" title={[event.by, event.detail].filter(Boolean).join(" — ")}>
                {[event.by, event.detail].filter(Boolean).join(" — ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {event.amount != null && event.amount !== 0 && (
            <span className="text-sm font-bold text-emerald-700">{fmtMoney(event.amount)}</span>
          )}
          <span className="text-[11px] text-slate-400 whitespace-nowrap">{formatEventDate(event)}</span>
        </div>
      </div>

      {doc && (
        <div className="mt-2 ml-9 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          {img ? (
            <img src={doc.url} alt={doc.fileName || "Document"} className="w-12 h-12 object-cover rounded border border-slate-200 flex-shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded bg-white border border-slate-200 flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-slate-400" />
            </div>
          )}
          <p className="text-xs font-semibold text-slate-700 truncate flex-1 min-w-0">{doc.fileName || "Document"}</p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {pdf && (
              <button onClick={onTogglePreview}
                className="px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors">
                {previewOpen ? "Hide" : "Preview"}
              </button>
            )}
            <a href={doc.url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors">
              <ExternalLink className="w-3 h-3" /> Open
            </a>
            <a href={doc.url} download={doc.fileName || undefined}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors">
              <Download className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}

      {pdf && previewOpen && (
        <div className="mt-2 ml-9">
          <iframe src={doc.url} title={doc.fileName || "Document preview"} className="w-full h-80 rounded-lg border border-slate-200" />
        </div>
      )}
    </li>
  );
}

export default function ActivityTab({ deal }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    if (!deal?.id) return;
    try {
      setLoadError(null);
      const res = await railwayDealTimeline.getTimeline(deal.id);
      setEvents(res?.events || []);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { url, key, fileName, contentType, size } = await uploadFileToStorage(file);
      await railwayDealTimeline.uploadCompletionForm(deal.id, {
        url, key, fileName: fileName || file.name, contentType: contentType || file.type, size: size || file.size,
      });
      await load();
    } catch (err) {
      setUploadError(err?.message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const activeFilter = FILTERS.find(f => f.id === filter);
  const visibleEvents = activeFilter?.categories
    ? events.filter(ev => activeFilter.categories.includes(ev.category))
    : events;

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-5">
        <EmptyState
          icon={AlertCircle}
          title="Could not load project history"
          description={loadError.status === 403
            ? "You do not have permission to view this project's activity."
            : (loadError.message || "Please try again.")}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                filter === f.id
                  ? "bg-amber-600 text-white border-amber-600"
                  : "bg-white text-slate-600 border-slate-200 hover:border-amber-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !deal?.id}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            Upload Completion Form
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_COMPLETION_FORM_TYPES}
            className="hidden"
            onChange={handleUpload}
          />
        </div>
      </div>

      {uploadError && (
        <div className="py-2.5 px-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-700 flex-1">{uploadError}</p>
          <button onClick={() => setUploadError(null)} className="text-red-400 hover:text-red-600 text-xs">✕</button>
        </div>
      )}

      {visibleEvents.length === 0 ? (
        <EmptyState
          icon={Clock}
          title={events.length === 0 ? "No project history yet" : "No events in this filter"}
          description={events.length === 0
            ? "Milestones, contract signing, payments, and documents will appear here automatically as this project progresses."
            : "Try a different filter, or select \"All\" to see the full project history."}
        />
      ) : (
        <div className="card-premium p-4">
          <p className="typography-section-header mb-4">PROJECT HISTORY</p>
          <ol className="relative border-l-2 border-slate-100 ml-3 space-y-5">
            {visibleEvents.map(ev => (
              <TimelineEvent
                key={ev.id}
                event={ev}
                previewOpen={previewId === ev.id}
                onTogglePreview={() => setPreviewId(prev => (prev === ev.id ? null : ev.id))}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
