import { useState } from 'react';
import { Send, AlertCircle, CheckCircle, Copy } from 'lucide-react';

export default function TestReminderPanel({ lead, onClose }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleSendTest = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Route through the shared email transport (Railway /internal/email/send)
      // instead of calling the Base44 function directly.
      const { sendTestEmail } = await import('@/lib/emailTransport');
      const nonce = lead.id;
      const result = await sendTestEmail('yaron@ecconstructiongroup.com', nonce);

      if (result && result.ok !== false) {
        setResult({
          success: true,
          message: `Test email sent to yaron@ecconstructiongroup.com via Railway Email Service.`,
          gmailMessageId: result.gmailMessageId,
          idempotent: result.idempotent,
        });
      } else {
        setError(result?.error || 'Failed to send test reminder');
      }
    } catch (e) {
      setError(e.message || 'Error sending test reminder');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const canSend = lead.follow_up_type === 'Meeting' && lead.follow_up_date && lead.follow_up_time;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-6">
      <div>
        <h3 className="text-lg font-bold text-slate-900 mb-2">Test Appointment Reminder</h3>
        <p className="text-sm text-slate-600">
          Send a test reminder email to yaron@ecconstructiongroup.com to verify formatting and merge fields before enabling automatic reminders.
        </p>
      </div>

      {!canSend && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900 mb-1">Cannot Send Test</p>
            <p className="text-xs text-amber-800">
              This lead must have a Meeting follow-up with a date and time set.
            </p>
            <div className="mt-2 text-xs text-amber-800 space-y-1">
              {lead.follow_up_type !== 'Meeting' && <div>• Follow-up Type: {lead.follow_up_type || 'Not set'}</div>}
              {!lead.follow_up_date && <div>• Follow-up Date: Not set</div>}
              {!lead.follow_up_time && <div>• Follow-up Time: Not set</div>}
            </div>
          </div>
        </div>
      )}

      {canSend && !result && !error && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <div>
              <p className="text-sm font-semibold text-blue-900 mb-1">Test Details</p>
              <div className="text-xs text-blue-800 space-y-1">
                <div><strong>Recipient:</strong> yaron@ecconstructiongroup.com</div>
                <div><strong>Client Name:</strong> {lead.first_name} {lead.last_name}</div>
                <div><strong>Appointment:</strong> {lead.follow_up_date} at {lead.follow_up_time}</div>
                <div><strong>Owner:</strong> {lead.assigned_rep || 'Not assigned'}</div>
                <div><strong>Type:</strong> {lead.follow_up_type}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-900">Error</p>
            <p className="text-xs text-red-800 mt-1">{error}</p>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex gap-3">
            <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-green-900">Test Email Sent!</p>
              <p className="text-xs text-green-800 mt-1">{result.message}</p>
              <p className="text-xs text-green-700 mt-2">Check Yaron's email to review the reminder formatting.</p>
            </div>
          </div>

          {result.preview && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-2">Email Subject:</p>
                <div className="bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm text-slate-900 font-mono break-words">
                  {result.preview.subject}
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-600 mb-2">Email Body Preview:</p>
                <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs text-slate-700 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                  {result.preview.body}
                </div>
                <button
                  onClick={() => copyToClipboard(result.preview.body)}
                  className="mt-2 flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-800 transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copied ? 'Copied!' : 'Copy body'}
                </button>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-600 mb-2">Debug Information:</p>
                <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs text-slate-700 font-mono whitespace-pre-wrap break-words">
                  {result.preview.debug}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-4 border-t border-slate-200">
        <button
          onClick={handleSendTest}
          disabled={!canSend || loading}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all ${
            canSend && !loading
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          }`}
        >
          <Send className="w-4 h-4" />
          {loading ? 'Sending...' : 'Send Test Reminder'}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="px-4 py-2 text-slate-600 hover:text-slate-900 font-semibold text-sm transition-colors"
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}