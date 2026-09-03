/**
 * SignNowPanel — Native Railway SignNow panel for Lead Detail.
 *
 * Lists SignNow documents for a lead, allows uploading PDFs for signing,
 * checking signing status, and downloading signed documents.
 *
 * Calls SignNow API directly via native Railway routes (no Base44).
 * Stores document metadata in the signnow_documents Postgres table.
 */
import { useState, useEffect, useCallback } from "react";
import { signnow as railwaySignnow } from "@/api/railway";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { useToast } from "@/components/ui/use-toast";
import { FileSignature, RefreshCw, Upload, Download, Trash2, ExternalLink, AlertCircle, CheckCircle2, Clock } from "lucide-react";

export default function SignNowPanel({ lead, onLeadUpdate }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  const loadDocuments = useCallback(async () => {
    if (!lead?.id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await railwaySignnow.listDocuments(lead.id);
      setDocuments(data.documents || []);
    } catch (e) {
      if (e.status === 404 || e.message === 'not_found') {
        // Lead not found in Railway — show empty state, not "Not Configured"
        setDocuments([]);
      } else if (e.message?.includes('not_configured') || e.message?.includes('SIGNNOW')) {
        setError('SignNow credentials not configured. Set SIGNNOW_CLIENT_ID, SIGNNOW_CLIENT_SECRET, SIGNNOW_USERNAME, and SIGNNOW_PASSWORD on Railway.');
      } else {
        setError(e.message || 'Failed to load documents');
      }
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      // Upload the PDF to R2/S3 storage (returns a public URL)
      const uploadRes = await uploadFileToStorage(file);
      const fileUrl = uploadRes?.url;

      if (!fileUrl) throw new Error('File upload failed');

      // Then create the SignNow document from the uploaded PDF
      const signers = lead.email ? [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'Signer 1' }] : [];
      const result = await railwaySignnow.uploadDocument(lead.id, {
        file_url: fileUrl,
        document_name: file.name,
        signers,
      });

      toast({ title: 'Document uploaded', description: 'SignNow document created and sent for signing', duration: 3000 });
      await loadDocuments();
    } catch (e) {
      toast({ title: 'Upload failed', description: e.message, variant: 'destructive', duration: 5000 });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleDelete = async (docId) => {
    if (!confirm('Delete this document record?')) return;
    try {
      await railwaySignnow.deleteDocument(docId);
      toast({ title: 'Document deleted', duration: 2000 });
      await loadDocuments();
    } catch (e) {
      toast({ title: 'Delete failed', description: e.message, variant: 'destructive' });
    }
  };

  const handleRefreshStatus = async (docId) => {
    try {
      await railwaySignnow.getDocumentStatus(docId);
      await loadDocuments();
      toast({ title: 'Status refreshed', duration: 2000 });
    } catch (e) {
      toast({ title: 'Refresh failed', description: e.message, variant: 'destructive' });
    }
  };

  const statusConfig = {
    pending: { color: 'text-slate-500', bg: 'bg-slate-50', icon: Clock },
    sent: { color: 'text-blue-600', bg: 'bg-blue-50', icon: ExternalLink },
    viewed: { color: 'text-blue-600', bg: 'bg-blue-50', icon: ExternalLink },
    signed: { color: 'text-amber-600', bg: 'bg-amber-50', icon: FileSignature },
    completed: { color: 'text-emerald-600', bg: 'bg-emerald-50', icon: CheckCircle2 },
    voided: { color: 'text-red-500', bg: 'bg-red-50', icon: AlertCircle },
    error: { color: 'text-red-500', bg: 'bg-red-50', icon: AlertCircle },
  };

  if (loading) {
    return (
      <div className="p-4 flex items-center justify-center">
        <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-amber-700">SignNow Not Configured</p>
            <p className="text-[11px] text-amber-600 mt-0.5">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Upload button */}
      <label className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
        <Upload className="w-3.5 h-3.5" />
        {uploading ? 'Uploading...' : 'Upload PDF for Signing'}
        <input type="file" accept=".pdf" onChange={handleUpload} disabled={uploading} className="hidden" />
      </label>

      {/* Documents list */}
      {documents.length === 0 ? (
        <div className="text-center py-4">
          <FileSignature className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
          <p className="text-xs text-slate-400">No documents yet</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Upload a PDF to send for signing</p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => {
            const cfg = statusConfig[doc.status] || statusConfig.pending;
            const StatusIcon = cfg.icon;
            return (
              <div key={doc.id} className={`border rounded-lg px-3 py-2.5 ${cfg.bg}`}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-800 truncate">{doc.document_name || 'Untitled'}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <StatusIcon className={`w-3 h-3 ${cfg.color}`} />
                      <span className={`text-[10px] font-semibold ${cfg.color} uppercase tracking-wide`}>{doc.status}</span>
                    </div>
                  </div>
                </div>

                {/* Signers */}
                {doc.signers && doc.signers.length > 0 && (
                  <div className="mb-1.5">
                    {doc.signers.map((s, i) => (
                      <p key={i} className="text-[10px] text-slate-500 truncate">→ {s.email}</p>
                    ))}
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 mt-1.5">
                  <button
                    onClick={() => handleRefreshStatus(doc.document_id)}
                    className="text-[10px] text-slate-500 hover:text-amber-600 font-semibold flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                  {doc.signing_url && (
                    <a href={doc.signing_url} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1">
                      <ExternalLink className="w-3 h-3" /> Sign
                    </a>
                  )}
                  {doc.pdf_url && (
                    <a href={doc.pdf_url} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-emerald-600 hover:text-emerald-700 font-semibold flex items-center gap-1">
                      <Download className="w-3 h-3" /> PDF
                    </a>
                  )}
                  <button
                    onClick={() => handleDelete(doc.document_id)}
                    className="text-[10px] text-red-400 hover:text-red-600 font-semibold flex items-center gap-1 ml-auto"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {doc.error_message && (
                  <p className="text-[10px] text-red-500 mt-1">{doc.error_message}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}