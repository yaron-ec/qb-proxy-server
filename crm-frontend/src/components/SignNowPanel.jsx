/**
 * SignNowPanel — Full template-copy contract workflow for Lead Detail.
 *
 * PRIMARY: Select a SignNow template → create a customer-specific COPY
 * → send for e-signature → track status → download signed PDF.
 *
 * SECONDARY (collapsible): Upload a PDF for signing.
 *
 * The original SignNow template is NEVER modified — only copied.
 * Document naming: "[Customer Name] - [Template Name]"
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { signnow as railwaySignnow } from "@/api/railway";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { useToast } from "@/components/ui/use-toast";
import {
  FileSignature, RefreshCw, Upload, Download, Trash2, ExternalLink,
  AlertCircle, CheckCircle2, Clock, ChevronDown, ChevronUp, Loader2,
  Send, FileText
} from "lucide-react";

export default function SignNowPanel({ lead, onLeadUpdate }) {
  const [documents, setDocuments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [error, setError] = useState(null);
  const [templateError, setTemplateError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(null);
  const { toast } = useToast();
  const refreshTimer = useRef(null);

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
        setDocuments([]);
      } else if (e.message?.includes('not_configured') || e.message?.includes('SIGNNOW')) {
        setError('SignNow credentials not configured. Set SIGNNOW_API_KEY on Railway or connect via Settings → SignNow.');
      } else {
        setError(e.message || 'Failed to load documents');
      }
    } finally {
      setLoading(false);
    }
  }, [lead?.id]);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    setTemplateError(null);
    try {
      const data = await railwaySignnow.listTemplates();
      if (data?.templates) {
        setTemplates(data.templates);
      } else {
        setTemplateError(data?.error || 'Failed to load templates');
      }
    } catch (e) {
      if (e.message?.includes('not_configured') || e.message?.includes('SIGNNOW')) {
        setTemplateError('SignNow not configured. Connect via Settings → SignNow first.');
      } else {
        setTemplateError(e.message || 'Failed to fetch templates');
      }
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
    loadTemplates();
  }, [loadDocuments, loadTemplates]);

  // Auto-refresh document statuses every 30s
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(async () => {
      if (documents.length > 0) {
        for (const doc of documents) {
          if (doc.status === 'pending' || doc.status === 'sent' || doc.status === 'viewed') {
            try {
              await railwaySignnow.getDocumentStatus(doc.document_id);
            } catch (e) { /* ignore */ }
          }
        }
        await loadDocuments();
      }
    }, 30000);
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); };
  }, [documents.length, loadDocuments]);

  const handlePrepareFromTemplate = async () => {
    if (!selectedTemplateId) {
      toast({ title: 'Select a template first', variant: 'destructive', duration: 3000 });
      return;
    }
    if (!lead?.id) return;

    setPreparing(true);
    try {
      const template = templates.find(t => t.id === selectedTemplateId);
      const customerName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();

      const result = await railwaySignnow.prepareFromTemplate(lead.id, {
        template_id: selectedTemplateId,
        template_name: template?.name || 'Contract',
        send_invite: true,
      });

      if (result.error === 'duplicate') {
        toast({
          title: 'Contract already exists',
          description: 'A pending contract from this template already exists for this lead.',
          variant: 'destructive',
          duration: 5000,
        });
      } else {
        toast({
          title: 'Contract created from template',
          description: `\"${result.document?.document_name || customerName}\" created and sent for signature.`,
          duration: 4000,
        });
      }

      setSelectedTemplateId("");
      await loadDocuments();
    } catch (e) {
      toast({
        title: 'Failed to create contract',
        description: e.message || 'SignNow template error',
        variant: 'destructive',
        duration: 5000,
      });
    } finally {
      setPreparing(false);
    }
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const uploadRes = await uploadFileToStorage(file);
      const fileUrl = uploadRes?.url;
      if (!fileUrl) throw new Error('File upload failed');

      const signers = lead.email ? [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'Signer 1' }] : [];
      await railwaySignnow.uploadDocument(lead.id, {
        file_url: fileUrl,
        document_name: file.name,
        signers,
      });

      toast({ title: 'Document uploaded', description: 'PDF uploaded and sent for signing', duration: 3000 });
      await loadDocuments();
      setShowUpload(false);
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

  const handleDownloadPdf = async (docId) => {
    setDownloadingPdf(docId);
    try {
      const blob = await railwaySignnow.downloadSignedPdf(docId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Signed_Contract_${docId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast({ title: 'PDF downloaded', duration: 2000 });
    } catch (e) {
      toast({ title: 'Download failed', description: e.message, variant: 'destructive' });
    } finally {
      setDownloadingPdf(null);
    }
  };

  const statusConfig = {
    pending: { color: 'text-slate-500', bg: 'bg-slate-50', icon: Clock, label: 'Pending' },
    sent: { color: 'text-blue-600', bg: 'bg-blue-50', icon: Send, label: 'Sent' },
    viewed: { color: 'text-blue-600', bg: 'bg-blue-50', icon: ExternalLink, label: 'Viewed' },
    signed: { color: 'text-amber-600', bg: 'bg-amber-50', icon: FileSignature, label: 'Signed' },
    completed: { color: 'text-emerald-600', bg: 'bg-emerald-50', icon: CheckCircle2, label: 'Completed' },
    voided: { color: 'text-red-500', bg: 'bg-red-50', icon: AlertCircle, label: 'Voided' },
    error: { color: 'text-red-500', bg: 'bg-red-50', icon: AlertCircle, label: 'Error' },
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
      {/* PRIMARY: Template Selection */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2.5">
        <div className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-amber-600" />
          <p className="text-xs font-bold text-amber-800">Create Contract from Template</p>
        </div>

        {templateError ? (
          <div className="flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-red-600">{templateError}</p>
          </div>
        ) : loadingTemplates ? (
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading templates...
          </div>
        ) : templates.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            No templates found in your SignNow account. Create templates in SignNow first.
          </p>
        ) : (
          <>
            <select
              value={selectedTemplateId}
              onChange={e => setSelectedTemplateId(e.target.value)}
              className="w-full border border-amber-200 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-700 bg-white focus:outline-none focus:border-amber-500"
            >
              <option value="">— Select a template —</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>

            {selectedTemplateId && lead?.email && (
              <p className="text-[10px] text-slate-500">
                Will be sent to: <span className="font-semibold">{lead.email}</span>
              </p>
            )}
            {selectedTemplateId && !lead?.email && (
              <p className="text-[10px] text-amber-600 font-semibold">
                ⚠ No email on this lead — add an email before sending
              </p>
            )}

            <button
              onClick={handlePrepareFromTemplate}
              disabled={!selectedTemplateId || preparing || !lead?.email}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {preparing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {preparing ? 'Creating...' : 'Create & Send for Signature'}
            </button>
          </>
        )}
      </div>

      {/* SECONDARY: Upload PDF (collapsible, not primary) */}
      <div className="border border-slate-200 rounded-lg">
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors rounded-lg"
        >
          <span className="flex items-center gap-1.5">
            <Upload className="w-3 h-3" /> Upload PDF (optional)
          </span>
          {showUpload ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showUpload && (
          <div className="px-3 pb-3">
            <label className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              {uploading ? 'Uploading...' : 'Choose PDF'}
              <input type="file" accept=".pdf" onChange={handleUpload} disabled={uploading} className="hidden" />
            </label>
          </div>
        )}
      </div>

      {/* Documents List */}
      {documents.length === 0 ? (
        <div className="text-center py-4">
          <FileSignature className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
          <p className="text-xs text-slate-400">No contracts yet</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Select a template above to create a contract</p>
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
                      <span className={`text-[10px] font-semibold ${cfg.color} uppercase tracking-wide`}>{cfg.label || doc.status}</span>
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
                  <a
                    href={`https://app.signnow.com/document/${doc.document_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" /> Open in SignNow
                  </a>
                  {(doc.status === 'signed' || doc.status === 'completed') && (
                    <button
                      onClick={() => handleDownloadPdf(doc.document_id)}
                      disabled={downloadingPdf === doc.document_id}
                      className="text-[10px] text-emerald-600 hover:text-emerald-700 font-semibold flex items-center gap-1 disabled:opacity-50"
                    >
                      {downloadingPdf === doc.document_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      PDF
                    </button>
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
