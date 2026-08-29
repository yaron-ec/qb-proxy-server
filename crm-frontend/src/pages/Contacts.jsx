import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Search, Phone, Mail, MapPin, Plus, Trash2, ExternalLink } from "lucide-react";
import { formatPhone, toTitleCase } from "@/lib/formatters";

export default function Contacts() {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');

  useEffect(() => {
    loadContacts();
    const interval = setInterval(loadContacts, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadContacts = async () => {
    try {
      const res = await apiCall('/api/v1/leads?record_type=Contact&limit=1000', { method: 'GET' });
      const all = Array.isArray(res) ? res : (res?.items || []);
      setContacts(all);
      setLoading(false);
    } catch (e) {
      console.error('Error loading contacts:', e);
      setLoading(false);
    }
  };

  const filtered = contacts
    .filter(c => {
      const text = `${c.first_name} ${c.last_name} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return text.includes(searchTerm.toLowerCase());
    })
    .filter(c => sourceFilter === 'all' || c.source === sourceFilter);

  const handleDelete = async (id) => {
    if (confirm('Delete this contact?')) {
      await apiCall(`/api/v1/leads/${id}`, { method: 'DELETE' });
      setContacts(c => c.filter(x => x.id !== id));
    }
  };

  const handleViewOriginalLead = (contactId) => {
    const contact = contacts.find(c => c.id === contactId);
    if (contact?.original_lead_id) {
      navigate(`/leads/${contact.original_lead_id}`);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-5 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between mb-4">
          <div>
            <Link to="/leads" className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 mb-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Leads
            </Link>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Contacts</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {filtered.length} contact{filtered.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search name, email, phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
            />
          </div>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          >
            <option value="all">All Sources</option>
            <option value="Google Contacts">Google Contacts</option>
            <option value="HubSpot Contacts">HubSpot Contacts</option>
            <option value="Manual">Manual</option>
          </select>
        </div>
      </div>

      {/* Contacts Grid */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <p className="text-sm">No contacts found</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(contact => (
              <div key={contact.id} className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all p-4">
                <div className="flex items-start justify-between gap-4">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-slate-300 to-slate-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                    {contact.first_name?.[0]}{contact.last_name?.[0]}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-slate-900">
                      {toTitleCase(contact.first_name)} {toTitleCase(contact.last_name)}
                    </h3>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2">
                      {contact.phone && (
                        <span className="flex items-center gap-1 text-xs text-slate-600">
                          <Phone className="w-3 h-3" /> {formatPhone(contact.phone)}
                        </span>
                      )}
                      {contact.email && (
                        <span className="flex items-center gap-1 text-xs text-slate-600 truncate">
                          <Mail className="w-3 h-3" /> {contact.email}
                        </span>
                      )}
                      {contact.city && (
                        <span className="flex items-center gap-1 text-xs text-slate-600">
                          <MapPin className="w-3 h-3" /> {toTitleCase(contact.city)}
                        </span>
                      )}
                    </div>
                    {contact.source && (
                      <div className="mt-2">
                        <span className="text-[10px] font-semibold text-slate-400 uppercase">
                          {contact.source}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {contact.original_lead_id && (
                      <button
                        onClick={() => handleViewOriginalLead(contact.id)}
                        className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                        title="View original lead record"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(contact.id)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}