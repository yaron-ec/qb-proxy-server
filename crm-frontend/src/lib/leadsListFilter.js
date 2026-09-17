/**
 * leadsListFilter.js — pure filter/sort composition for the Active Leads
 * list (pages/LeadsModern.jsx). Extracted so the Search + Status +
 * Website-only + Sales-Rep(owner) + Sort composition can be unit-tested
 * directly, without mounting the full page (which pulls in drag/drop,
 * live user/lead fetching, and several other concerns unrelated to this
 * pure computation).
 *
 * Ownership/visibility note: this ONLY controls what the client renders.
 * The real authorization boundary is server-side — railwayLeads.list()
 * already returns a sales_rep-scoped result set (routes/leads.js's
 * resolveOwnerScope), so a sales_rep cannot see another rep's leads by
 * manipulating ownerFilter/any other param here; this function's
 * `userRole === 'sales_rep'` branch just skips an already-moot owner
 * filter on an already-scoped list.
 */
import { isActiveSalesLead } from './activeLeadFilter';
import { sortActiveLeads } from './sortActiveLeads';

export function filterAndSortLeads(leads, opts = {}) {
  const {
    searchTerm = '',
    statusFilter = 'all',
    sourceFilter = 'all',
    ownerFilter = 'all',
    sortField = 'follow_up',
    userRole = null,
    userOwner = null,
  } = opts;

  const isGlobalSearch = searchTerm.trim().length > 0;
  const mineNameLower = userOwner ? userOwner.trim().toLowerCase().replace(/\s+/g, ' ') : null;

  const baseFiltered = (leads || [])
    .filter(lead => {
      if (isGlobalSearch) {
        const searchText = `${lead.first_name} ${lead.last_name} ${lead.email || ''} ${lead.phone || ''} ${lead.city || ''} ${lead.property_address || ''} ${lead.assigned_rep || ''} ${lead.project_type || ''} ${lead.notes || ''}`.toLowerCase();
        return searchText.includes(searchTerm.toLowerCase());
      }
      // If a specific status filter is set, don't exclude any statuses — show exactly what's filtered
      if (statusFilter !== 'all') return true;
      // Default: show only active leads
      return isActiveSalesLead(lead);
    })
    .filter(lead => {
      if (isGlobalSearch) return true;
      return statusFilter === 'all' || lead.status === statusFilter;
    })
    .filter(lead => {
      if (isGlobalSearch) return true;
      return sourceFilter === 'all' || lead.source === 'Website';
    })
    .filter(lead => {
      // sales_rep: RLS already scopes to their assigned leads, skip owner filter
      if (userRole === 'sales_rep') return true;
      if (isGlobalSearch) return true;
      if (ownerFilter === 'all') return true;
      if (ownerFilter === 'unassigned') {
        // leads.owner_id is NOT NULL — a genuinely ownerless lead does not
        // exist in this schema. "Unassigned" is instead a real, canonical
        // `owners` row (display_name='Unassigned', seeded during the
        // Base44->Railway migration to satisfy that constraint), so
        // assigned_rep for these leads is the literal string "Unassigned",
        // never empty. Matching only an empty string meant this filter
        // option could never match any real lead. Still also match a
        // genuinely empty value defensively, in case one ever occurs.
        const rep = (lead.assigned_rep || '').trim().toLowerCase();
        return rep === '' || rep === 'unassigned';
      }
      if (ownerFilter === '__mine__') {
        if (!mineNameLower) return false;
        return (lead.assigned_rep || '').trim().toLowerCase().replace(/\s+/g, ' ') === mineNameLower;
      }
      return lead.assigned_rep?.trim().toLowerCase() === ownerFilter.toLowerCase();
    });

  if (sortField === 'follow_up') return sortActiveLeads(baseFiltered);

  return [...baseFiltered].sort((a, b) => {
    if (sortField === 'created') {
      return new Date(b.crm_created_date || b.created_date || 0) - new Date(a.crm_created_date || a.created_date || 0);
    }
    if (sortField === 'updated') {
      return new Date(b.updated_date || 0) - new Date(a.updated_date || 0);
    }
    return 0;
  });
}
