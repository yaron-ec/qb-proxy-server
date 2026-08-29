import { useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";

export default function MyDiag() {
  const { user } = useAuth();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await railwayLeads.list({ limit: 2000 });
      const leads = res.items || [];
      setResult({
        user: { email: user?.email, role: user?.role, full_name: user?.full_name },
        totalLeads: leads.length,
        first5: leads.slice(0, 5).map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}`, status: l.status, assigned_rep: l.assigned_rep })),
      });
    } catch (e) {
      setResult({ error: e.message });
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-8">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 max-w-2xl w-full">
        <h1 className="text-xl font-bold text-slate-900 mb-2">My Leads Diagnostic</h1>
        <p className="text-sm text-slate-500 mb-6">
          This runs as <strong>your</strong> logged-in session and shows exactly what the database returns for your account.
          Have <strong>Ethan</strong> open this page while logged in as himself.
        </p>
        <button
          onClick={run}
          disabled={loading}
          className="bg-amber-600 hover:bg-amber-700 text-white font-bold px-6 py-3 rounded-lg transition-colors disabled:opacity-50 w-full"
        >
          {loading ? "Running…" : "Run Diagnostic as Me"}
        </button>

        {result && (
          <div className="mt-6 bg-slate-900 text-green-400 font-mono text-xs rounded-lg p-5 overflow-auto max-h-[60vh]">
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}