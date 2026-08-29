import { OWNER_COLORS } from "@/pages/DailyMap";

export default function MapFilters({
  ownerFilter, setOwnerFilter,
  cityFilter, setCityFilter,
  projectTypeFilter, setProjectTypeFilter,
  owners, cities, projectTypes,
  hideOwnerFilter = false
}) {
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {/* Owner filter — hidden for sales_rep */}
      {!hideOwnerFilter && (
        <select
          value={ownerFilter}
          onChange={e => setOwnerFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white focus:outline-none focus:border-amber-500"
        >
          <option value="all">All Owners</option>
          <option value="Unassigned">Unassigned</option>
          {owners.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}

      {/* City filter */}
      <select
        value={cityFilter}
        onChange={e => setCityFilter(e.target.value)}
        className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white focus:outline-none focus:border-amber-500"
      >
        <option value="all">All Cities</option>
        {cities.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      {/* Project type filter */}
      <select
        value={projectTypeFilter}
        onChange={e => setProjectTypeFilter(e.target.value)}
        className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white focus:outline-none focus:border-amber-500"
      >
        <option value="all">All Project Types</option>
        {projectTypes.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  );
}