import React, { useEffect, useRef, useState } from 'react';
import { FileText, ExternalLink, Upload, Loader2, Trash2, Plus, Receipt, DollarSign } from 'lucide-react';
import { leadAttachments as railwayLeadAttachments } from '@/api/railway';
import { fmtMoney, fmtDate } from '@/lib/formatters';
import { uploadFileToStorage } from '@/lib/fileUpload';

export default function AttachmentsPanel({ lead }) {
  const [invoiceAttachments, setInvoiceAttachments] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // "Uploading file.pdf (1/2)..."
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);

  const load = async () => {
    if (!lead?.railway_id) return;
    const res = await railwayLeadAttachments.list({ lead_id: lead.railway_id });
    const all = res.items || [];
    setInvoiceAttachments(all.filter(a => a.file_type === 'invoice'));
    setUploadedFiles(all.filter(a => a.file_type !== 'invoice'));
  };

  useEffect(() => {
    load();
    // Real-time subscription removed — Railway has no client-side subscribe.
  }, [lead?.railway_id]);

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    setUploading(true);
    setUploadError(null);
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(`Uploading "${file.name}" (${i + 1}/${files.length})…`);
      try {
        // Upload directly to Railway → R2/S3 — zero Base44 integration credits used
        const { url, key, fileName, contentType, size } = await uploadFileToStorage(file);
        const res = await railwayLeadAttachments.create({
          lead_id: lead.railway_id,
          file_name: fileName || file.name,
          file_url: url,
          file_type: contentType || file.type || 'file',
          file_size: size || file.size,
          storage_key: key,
          uploaded_by: 'user',
          uploaded_at: new Date().toISOString(),
        });
        setUploadedFiles(prev => [...prev, res.attachment || res]);
      } catch (err) {
        console.error('Upload failed:', err);
        const msg = err?.message || 'Unknown error';
        errors.push(`"${file.name}": ${msg}`);
      }
    }

    setUploading(false);
    setUploadProgress(null);
    e.target.value = '';

    if (errors.length > 0) {
      setUploadError(`Upload failed for ${errors.length} file(s):\n${errors.join('\n')}`);
    }
  };

  const handleDelete = async (attachmentId) => {
    if (!confirm('Delete this attachment?')) return;
    await railwayLeadAttachments.remove(attachmentId);
    load();
  };

  const totalCount = invoiceAttachments.length + uploadedFiles.length;

  return (
    <div className="space-y-0">
      {/* Slim action bar */}
      <div className="flex items-center justify-end px-4 py-2 border-b border-slate-100 bg-slate-50/50">
        <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
          className="flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-900 transition-colors disabled:opacity-50 btn-compact">
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Upload
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange}
          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
      </div>
      <div className="p-3 space-y-2">

      {/* Invoice PDFs — from QuickBooks only */}
      {invoiceAttachments.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[9px] font-bold tracking-wide text-slate-400">QB invoices</p>
          {invoiceAttachments.map(inv => (
            <div key={inv.id} className="flex items-center justify-between bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 bg-emerald-100 rounded-md flex items-center justify-center flex-shrink-0">
                  <Receipt className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-700 truncate" title={inv.file_name}>{inv.file_name}</p>
                  <div className="flex items-center gap-2 text-[9px] text-slate-400 mt-0.5 flex-wrap">
                     {inv.invoice_amount && <span className="text-emerald-700 font-bold">{fmtMoney(inv.invoice_amount)}</span>}
                     {inv.invoice_date && <span>{fmtDate(inv.invoice_date)}</span>}
                     {inv.balance_due != null && inv.balance_due > 0 && (
                       <span className="text-amber-600 font-semibold">Balance: {fmtMoney(inv.balance_due)}</span>
                     )}
                     {inv.balance_due === 0 && <span className="text-emerald-600 font-bold">Paid</span>}
                   </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {inv.file_url ? (
                  <a
                    href={inv.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-bold rounded border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" /> PDF
                  </a>
                ) : (
                  <span className="text-[9px] text-slate-400 italic">No PDF</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Manually Uploaded Files */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-1.5">
          {invoiceAttachments.length > 0 && (
            <p className="text-[9px] font-bold tracking-wide text-slate-400">Files</p>
          )}
          {uploadedFiles.map(file => (
            <div key={file.id} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 group">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 bg-slate-100 rounded-md flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-slate-500" />
                </div>
                <p className="text-xs font-semibold text-slate-700 truncate" title={file.file_name || 'Attachment'}>{file.file_name || 'Attachment'}</p>
              </div>
              <div className="flex items-center gap-1">
                {file.file_url && (
                  <a href={file.file_url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors">
                    <ExternalLink className="w-3 h-3" /> Open
                  </a>
                )}
                <button onClick={() => handleDelete(file.id)}
                  className="p-1.5 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="flex items-center gap-2 py-2.5 px-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          <span>{uploadProgress || 'Uploading…'}</span>
        </div>
      )}

      {uploadError && (
        <div className="py-2.5 px-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-2">
            <span className="text-red-500 text-sm flex-shrink-0">⚠</span>
            <div>
              <p className="text-xs font-semibold text-red-700 mb-0.5">Upload failed</p>
              <p className="text-[11px] text-red-600 whitespace-pre-line">{uploadError}</p>
              {uploadError.includes('Proxy URL not configured') && (
                <p className="text-[10px] text-amber-700 mt-1 font-medium">
                  Set the Railway proxy URL in Settings → Integrations to enable file uploads.
                </p>
              )}
            </div>
            <button onClick={() => setUploadError(null)} className="ml-auto text-red-400 hover:text-red-600 flex-shrink-0">✕</button>
          </div>
        </div>
      )}

      {totalCount === 0 && !uploading && (
        <button onClick={() => fileInputRef.current?.click()}
          className="w-full flex flex-col items-center justify-center gap-2 py-4 border border-dashed border-slate-200 rounded-lg text-slate-300 hover:text-amber-500 hover:border-amber-200 transition-colors">
          <Upload className="w-4 h-4" />
          <span className="text-[11px] font-medium">Click to upload</span>
        </button>
      )}
      </div>
    </div>
  );
}