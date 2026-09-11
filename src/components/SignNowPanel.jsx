/**
 * SignNowPanel — Native Railway SignNow panel for Lead Detail.
 *
 * PRIMARY WORKFLOW: Template-based contract creation
 *   1. Fetches available templates from the connected SignNow account
 *   2. User selects a template → document is copied from template
 *   3. Field invite is sent to the customer's email
 *   4. Document status is tracked (pending → sent → viewed → signed → completed)
 *   5. Signed PDF can be downloaded and saved to lead attachments
 *
 * SECONDARY (optional): PDF upload for signing (collapsible)
 *
 * Calls SignNow API directly via native Railway routes (no Base44).
 * Stores document metadata in the signnow_documents Postgres table.
 */
import { useState, useEffect, useCallback } from "react";
import { signnow as railwaySignnow } from "@/api/railway";
import { uploadFileToStorage } from "@/lib/fileUpload";
import { useToast } from "@/components/ui/use-toast";
import {
  FileSignature, RefreshCw, Upload, Download, Trash2, ExternalLink,
  AlertCircle, CheckCircle2, Clock, FileText, ChevronDown, ChevronUp,
  Send, Loader2
} from "lucide-react";

export default function SignNowPanel({ lead, onLeadUpdate }) {
  const [documents, setDocuments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [accountEmail, setAccountEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [error, setError] = useState(null);
  const [templateError, setTemplateError] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const { toast } = useToast();

  // Load documents for this lead
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

  // Load available templates from the connected SignNow account
  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    setTemplateError(null);
    try {
      const data = await railwaySignnow.listTemplates();
      setTemplates(data.templates || []);
      setAccountEmail(data.account_email || '');
    } catch (e) {
      if (e.message?.includes('not_configured') || e.message?.includes('SIGNNOW')) {
        setTemplateError('SignNow not connected. Connect via Settings → SignNow first.');
      } else {
        setTemplateError(e.message || 'Failed to load templates');
      }
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await loadDocuments();
      await loadTemplates();
    };
    init();
  }, [loadDocuments, loadTemplates]);

  // Create a contract from a SignNow template and send for signature
  const handlePrepareFromTemplate = async () => {
    if (!selectedTemplateId) {
      toast({ title: 'Select a template first', variant: 'destructive', duration: 3000 });
      return;
    }
    if (!lead?.email) {
      toast({ title: 'Lead has no email', description: 'Add an email to the lead before sending for signature', variant: 'destructive', duration: 5000 });
      return;
    }
    setPreparing(true);
    try {
      const template = templates.find(t => t.id === selectedTemplateId);
      const docName = template?.name || 'Contract';
      const signers = [{ email: lead.email, name: `${lead.first_name} ${lead.last_name}`, role: 'Signer 1' }];
      const result = await railwaySignnow.prepareFromTemplate(lead.id, {
        template_id: selectedTemplateId,
        document_name: docName,
        signers,
      });
      toast({
        title: 'Contract sent for signature',
        description: `"${docName}" sent to ${lead.email}`,
        duration: 4000,
      });
      setSelectedTemplateId('');
      await loadDocuments();
    } catch (e) {
      toast({ title: 'Failed to create contract', description: e.message, variant: 'destructive', duration: 5000 });
    } finally {
      setPreparing(false);
    }
  };

  // Optional: upload a PDF for signing (secondary workflow)
  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const uploadRes = await uploadFileToStorage(file);
      const fileUrl = uploadRes?.url;
      if (!fileUrl) throw new Error('File upload failed');

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

  const handleRefreshAll = async () => {
    // Refresh all document statuses
    for (const doc of documents) {
      if (doc.document_id && doc.status !== 'completed' && doc.status !== 'signed') {
        try {
          await railwaySignnow.getDocumentStatus(doc.document_id);
        } catch (e) { /* skip individual errors */ }
      }
    }
    await loadDocuments();
    toast({ title: 'All statuses refreshed', duration: 2000 });
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
      {/* ── PRIMARY: Template-based contract creation ─────────────────────── */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-amber-600" />
            <p className="text-xs font-bold text-slate-700">Create from Template</p>
          </div>
          <button
            onClick={loadTemplates}
            disabled={loadingTemplates}
            className="text-[10px] text-slate-500 hover:text-amber-600 font-semibold flex items-center gap-1 disabled:opacity-50"
          >
            {loadingTemplates ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </button>
        </div>

        {templateError && (
          <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-red-600">{templateError}</p>
          </div>
        )}

        {!templateError && templates.length === 0 && !loadingTemplates && (
          <div className="text-center py-2">
            <p className="text-[11px] text-slate-400">
              {accountEmail ? `No templates found in the connected SignNow account (${accountEmail}).` : 'No SignNow templates available. Connect SignNow in Settings and create templates in your SignNow account.'}
            </p>
          </div>
        )}

        {templates.length > 0 && (
          <>
            <select
              value={selectedTemplateId}
              onChange={e => setSelectedTemplateId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:border-amber-500 bg-white"
            >
              <option value="">— Select a template —</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>

            {selectedTemplateId && (
              <div className="text-[10px] text-slate-500 bg-white border border-slate-100 rounded px-2 py-1.5">
                {lead?.email ? (
                  <>Will be sent to: <span className="font-semibold text-slate-700">{lead.email}</span></>
                ) : (
                  <span className="text-amber-600 font-semibold">⚠ Lead has no email — add one before sending</span>
                )}
              </div>
            )}

            <button
              onClick={handlePrepareFromTemplate}
              disabled={!selectedTemplateId || preparing || !lead?.email}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {preparing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {preparing ? 'Creating & Sending...' : 'Create Contract & Send for Signature'}
            </button>
          </>
        )}
      </div>

      {/* ── Documents list ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          {documents.length} Document{documents.length !== 1 ? 's' : ''}
        </p>
        {documents.length > 0 && (
          <button
            onClick={handleRefreshAll}
            className="text-[10px] text-slate-500 hover:text-amber-600 font-semibold flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Refresh All
          </button>
        )}
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-4">
          <FileSignature className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
          <p className="text-xs text-slate-400">No documents yet</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Select a template above to create a contract</p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => {
            const cfg = statusConfig[doc.status] || statusConfig.pending;
            const StatusIcon = cfg.icon;
            const editorUrl = doc.signing_url || `https://app.signnow.com/webapp/document/${doc.document_id}`;
            return (
              <div key={doc.id} className={`border rounded-lg px-3 py-2.5 ${cfg.bg}`}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-800 truncate">{doc.document_name || 'Untitled'}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <StatusIcon className={`w-3 h-3 ${cfg.color}`} />
                      <span className={`text-[10px] font-semibold ${cfg.color} uppercase tracking-wide`}>{cfg.label}</span>
                      {doc.template_id && (
                        <span className="text-[9px] text-slate-400 bg-white border border-slate-200 px-1 py-0.5 rounded">template</span>
                      )}
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
                  <a href={editorUrl} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> Open
                  </a>
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

      {/* ── SECONDARY: Optional PDF upload (collapsible) ──────────────────── */}
      <div className="border-t border-slate-100 pt-2">
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-600 font-semibold py-1"
        >
          <span className="flex items-center gap-1">
            <Upload className="w-3 h-3" /> Upload PDF instead (optional)
          </span>
          {showUpload ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showUpload && (
          <label className="mt-2 flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg transition-colors cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            {uploading ? 'Uploading...' : 'Choose PDF file'}
            <input type="file" accept=".pdf" onChange={handleUpload} disabled={uploading} className="hidden" />
          </label>
        )}
      </div>
    </div>
  );
}