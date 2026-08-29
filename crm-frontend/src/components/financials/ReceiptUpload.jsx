import { useState } from "react";
import { FileText, Eye, Download, RefreshCw, X, Upload } from "lucide-react";
import { uploadFileToStorage, getSignedFileUrl, deleteFileFromStorage, extractKey } from "@/lib/fileUpload";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic";

export default function ReceiptUpload({ value, filename, fileKey, onChange, onRemove, disabled }) {
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Effective R2 object key: stored key preferred; for legacy malformed URLs,
  // safely extract the uploads/... portion only when no stored key exists.
  const currentKey = fileKey || extractKey(value);

  const handle = async (file) => {
    if (!file) return;
    setErr(null);
    setUploading(true);
    try {
      const res = await uploadFileToStorage(file);
      // Replace: upload new + pass new key to parent. Old-object cleanup is
      // performed by the parent AFTER the new key is saved to the database.
      onChange({ url: res.url, key: res.key, filename: res.fileName || file.name, mime: res.contentType || file.type });
    } catch (e) {
      setErr(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const view = async () => {
    if (!currentKey) { setErr("No receipt file to view."); return; }
    setErr(null); setBusy(true);
    try {
      const url = await getSignedFileUrl(currentKey, "inline");
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e.message || "Could not open receipt.");
    } finally { setBusy(false); }
  };

  const download = async () => {
    if (!currentKey) { setErr("No receipt file to download."); return; }
    setErr(null); setBusy(true);
    try {
      const url = await getSignedFileUrl(currentKey, "attachment");
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setErr(e.message || "Could not download receipt.");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setErr(null);
    if (currentKey) {
      setBusy(true);
      try {
        await deleteFileFromStorage(currentKey);
      } catch (e) {
        setBusy(false);
        setErr("Could not delete the receipt file — the receipt was kept. " + (e.message || ""));
        return;
      }
      setBusy(false);
    }
    onRemove();
  };

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <span className="truncate max-w-[180px] text-slate-700 font-medium">{filename || "Receipt"}</span>
        <button type="button" onClick={view} disabled={busy} className="inline-flex items-center gap-1 text-amber-600 font-semibold hover:underline disabled:opacity-50">
          <Eye className="w-3 h-3" /> {busy ? "Loading…" : "View"}
        </button>
        <button type="button" onClick={download} disabled={busy} className="inline-flex items-center gap-1 text-blue-600 font-semibold hover:underline disabled:opacity-50">
          <Download className="w-3 h-3" /> Download
        </button>
        {!disabled && (
          <>
            <label className="inline-flex items-center gap-1 text-slate-600 font-semibold cursor-pointer hover:underline">
              <RefreshCw className="w-3 h-3" /> Replace
              <input type="file" accept={ACCEPT} className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
            </label>
            <button type="button" onClick={remove} disabled={busy} className="inline-flex items-center gap-1 text-rose-600 font-semibold hover:underline disabled:opacity-50">
              <X className="w-3 h-3" /> Remove
            </button>
          </>
        )}
        {err && <span className="text-rose-600">{err}</span>}
      </div>
    );
  }

  return (
    <div>
      <label
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50 cursor-pointer ${
          disabled || uploading || busy ? "opacity-50 pointer-events-none" : ""
        }`}
      >
        <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading…" : "Upload Receipt"}
        <input type="file" accept={ACCEPT} className="hidden" onChange={(e) => handle(e.target.files?.[0])} disabled={disabled} />
      </label>
      {err && <p className="text-[11px] text-rose-600 mt-1">{err}</p>}
    </div>
  );
}