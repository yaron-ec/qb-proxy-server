import { useState, useEffect, useMemo } from "react";
import * as railwayLeads from "@/api/railway/leads";
import { ChevronDown, ChevronRight, MapPin, Calendar, Users, AlertTriangle, RefreshCw, Bug } from "lucide-react";

// ── Region classification ──────────────────────────────────────────────────

// Latitude-based approach: cities explicitly tagged as Northern or Southern.
// Anything NOT in either list and not matched → "Needs Region Review"

const NORTHERN_CITIES = new Set([
  'san francisco', 'oakland', 'berkeley', 'san jose', 'palo alto', 'sunnyvale',
  'mountain view', 'hayward', 'fremont', 'daly city', 'vallejo', 'concord',
  'walnut creek', 'sacramento', 'stockton', 'modesto', 'merced', 'fresno',
  'visalia', 'bakersfield', 'tulare', 'hanford', 'lodi', 'tracy', 'manteca',
  'turlock', 'madera', 'clovis', 'porterville', 'san luis obispo', 'atascadero',
  'paso robles', 'santa cruz', 'salinas', 'monterey', 'king city', 'coalinga',
  'ridgecrest', 'kern county', 'tulare county', 'inyo county', 'mono county',
  'kings county', 'ione', 'amador', 'auburn', 'roseville', 'elk grove',
  'folsom', 'davis', 'chico', 'redding', 'eureka', 'santa rosa', 'napa',
  'fairfield', 'vacaville', 'antioch', 'richmond', 'san mateo', 'palo alto',
  'redwood city', 'south san francisco', 'san rafael', 'novato', 'petaluma',
  'gilroy', 'morgan hill', 'los banos', 'delano', 'wasco', 'shafter',
  'tehachapi', 'arvin', 'lamont', 'rosamond', 'california city',
]);

const SOUTHERN_CITIES = new Set([
  'los angeles', 'san diego', 'anaheim', 'long beach', 'riverside', 'irvine',
  'santa ana', 'oxnard', 'torrance', 'pasadena', 'ventura', 'huntington beach',
  'glendale', 'oceanside', 'ontario', 'fontana', 'santa barbara', 'thousand oaks',
  'moreno valley', 'murrieta', 'temecula', 'victorville', 'palmdale', 'lancaster',
  'rancho cucamonga', 'corona', 'costa mesa', 'fullerton', 'norwalk', 'garden grove',
  'huntington park', 'santa monica', 'malibu', 'ojai', 'camarillo', 'port hueneme',
  'simi valley', 'agoura hills', 'calabasas', 'westlake village', 'newbury park',
  'burbank', 'culver city', 'west hollywood', 'beverly hills', 'santa clarita',
  'valencia', 'chatsworth', 'reseda', 'van nuys', 'northridge', 'woodland hills',
  'canoga park', 'el monte', 'pomona', 'ontario', 'chino', 'chino hills',
  'upland', 'montclair', 'claremont', 'glendora', 'azusa', 'covina', 'west covina',
  'la puente', 'walnut', 'diamond bar', 'rowland heights', 'hacienda heights',
  'la habra heights', 'whittier', 'pico rivera', 'montebello', 'commerce',
  'bell', 'bell gardens', 'maywood', 'downey', 'bellflower', 'cerritos',
  'lakewood', 'compton', 'inglewood', 'hawthorne', 'gardena', 'lawndale',
  'el segundo', 'manhattan beach', 'hermosa beach', 'redondo beach', 'palos verdes',
  'san pedro', 'carson', 'wilmington', 'signal hill', 'seal beach', 'cypress',
  'buena park', 'la palma', 'los alamitos', 'stanton', 'westminster',
  'fountain valley', 'santa ana', 'tustin', 'orange', 'villa park', 'placentia',
  'yorba linda', 'brea', 'la habra', 'whittier', 'poway', 'santee', 'el cajon',
  'la mesa', 'spring valley', 'lemon grove', 'national city', 'chula vista',
  'bonita', 'san ysidro', 'escondido', 'san marcos', 'vista', 'carlsbad',
  'encinitas', 'solana beach', 'del mar', 'la jolla', 'mission viejo',
  'lake forest', 'aliso viejo', 'laguna niguel', 'laguna hills', 'laguna woods',
  'laguna beach', 'dana point', 'san clemente', 'san juan capistrano',
  'rancho santa margarita', 'foothill ranch', 'coto de caza', 'ladera ranch',
  'perris', 'hemet', 'san jacinto', 'beaumont', 'banning', 'palm springs',
  'palm desert', 'la quinta', 'indio', 'coachella', 'desert hot springs',
  'yucca valley', 'twenty-nine palms', 'barstow', 'apple valley', 'hesperia',
  'big bear lake', 'redlands', 'yucaipa', 'loma linda', 'highland',
  'san bernardino', 'colton', 'rialto', 'bloomington', 'mira loma', 'eastvale',
  'norco', 'jurupa valley', 'lake elsinore', 'wildomar', 'menifee',
  'sun city', 'canyon lake', 'san dimas', 'la verne', 'san gabriel',
  'alhambra', 'monterey park', 'rosemead', 'temple city', 'arcadia',
  'monrovia', 'duarte', 'irwindale', 'industry', 'baldwin park', 'west puente valley',
]);

function classifyCity(rawCity) {
  if (!rawCity || !rawCity.trim()) return { city: 'Unknown City', region: 'Unknown Region' };
  const city = rawCity.trim();
  const norm = city.toLowerCase();

  // Exact or substring match
  for (const c of NORTHERN_CITIES) {
    if (norm === c || norm.startsWith(c + ',') || norm.startsWith(c + ' ')) {
      return { city, region: 'Northern California' };
    }
  }
  for (const c of SOUTHERN_CITIES) {
    if (norm === c || norm.startsWith(c + ',') || norm.startsWith(c + ' ')) {
      return { city, region: 'Southern California' };
    }
  }

  // Partial: city name contains a known city
  for (const c of NORTHERN_CITIES) {
    if (norm.includes(c)) return { city, region: 'Northern California' };
  }
  for (const c of SOUTHERN_CITIES) {
    if (norm.includes(c)) return { city, region: 'Southern California' };
  }

  return { city, region: 'Needs Region Review' };
}

function getLeadDate(lead) {
  return lead.created_date
    || lead.received_date
    || lead.hubspot_created_date
    || lead.appointment_date
    || lead.follow_up_date
    || null;
}

function buildBreakdown(leads) {
  // Structures:
  // byRegion: { region: count }
  // byCity: { city: count }
  // byYear: { year: count }
  // byMonth: { 'YYYY-MM': count }
  // monthCities: { 'YYYY-MM': { city: [leads] } }
  // regionCities: { region: { city: count } }
  // debug: { total, counted, unknownCity, unknownRegion, byYear, byRegion }

  const byRegion = {};
  const byCity = {};
  const byYear = {};
  const byMonth = {};
  const monthCities = {};
  const regionCities = {};

  let unknownCity = 0;
  let unknownRegion = 0;

  leads.forEach(lead => {
    const { city, region } = classifyCity(lead.city);

    if (city === 'Unknown City') unknownCity++;
    if (region === 'Unknown Region' || region === 'Needs Region Review') unknownRegion++;

    byRegion[region] = (byRegion[region] || 0) + 1;
    byCity[city] = (byCity[city] || 0) + 1;

    // Region → City breakdown
    if (!regionCities[region]) regionCities[region] = {};
    regionCities[region][city] = (regionCities[region][city] || 0) + 1;

    // Date
    const dateStr = getLeadDate(lead);
    let year = 'Unknown Year';
    let monthKey = 'Unknown-Month';

    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d)) {
        year = String(d.getFullYear());
        const m = String(d.getMonth() + 1).padStart(2, '0');
        monthKey = `${year}-${m}`;
      }
    }

    byYear[year] = (byYear[year] || 0) + 1;
    byMonth[monthKey] = (byMonth[monthKey] || 0) + 1;

    // Month → City → leads
    if (!monthCities[monthKey]) monthCities[monthKey] = {};
    if (!monthCities[monthKey][city]) monthCities[monthKey][city] = [];
    monthCities[monthKey][city].push(lead);
  });

  return {
    byRegion,
    byCity,
    byYear,
    byMonth,
    monthCities,
    regionCities,
    debug: {
      total: leads.length,
      counted: leads.length,
      unknownCity,
      unknownRegion,
      byYear,
      byRegion,
    },
  };
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtMonthKey(key) {
  if (!key || key === 'Unknown-Month') return 'Unknown Date';
  const [y, m] = key.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES[idx] || m} ${y}`;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function LeadGeographyReport() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedMonths, setExpandedMonths] = useState({});
  const [expandedMonthCities, setExpandedMonthCities] = useState({});
  const [showDebug, setShowDebug] = useState(false);
  const [activeRegionTab, setActiveRegionTab] = useState('Northern California');

  const loadLeads = async () => {
    setLoading(true);
    try {
      const r = await railwayLeads.list({ sort: '-created_date', limit: 5000 });
      const all = r.items || [];
      setLeads(all.filter(l =>
        !l.first_name?.toLowerCase().includes('unknown') &&
        !l.last_name?.toLowerCase().includes('unknown')
      ));
    } catch (e) {
      console.error('Failed to load leads:', e);
      setLeads([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadLeads();
  }, []);

  const data = useMemo(() => buildBreakdown(leads), [leads]);

  const sortedMonths = useMemo(() =>
    Object.keys(data.byMonth)
      .filter(k => k !== 'Unknown-Month')
      .sort((a, b) => b.localeCompare(a))
      .concat(data.byMonth['Unknown-Month'] ? ['Unknown-Month'] : []),
    [data.byMonth]
  );

  const sortedYears = useMemo(() =>
    Object.entries(data.byYear).sort((a, b) => b[0].localeCompare(a[0])),
    [data.byYear]
  );

  const toggleMonth = (key) => setExpandedMonths(p => ({ ...p, [key]: !p[key] }));
  const toggleMonthCity = (key) => setExpandedMonthCities(p => ({ ...p, [key]: !p[key] }));

  const REGIONS = ['Northern California', 'Southern California', 'Needs Region Review'];

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-12 justify-center text-slate-500">
        <RefreshCw className="w-5 h-5 animate-spin" />
        <span className="text-sm font-medium">Loading all leads...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Lead Geography & Date Breakdown</h2>
          <p className="text-xs text-slate-500 mt-0.5">{data.debug.total} leads scanned · live data</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowDebug(d => !d)}
            className="flex items-center gap-1.5 text-xs border border-slate-200 rounded-lg px-3 py-1.5 text-slate-500 hover:bg-slate-50 transition-colors"
          >
            <Bug className="w-3.5 h-3.5" /> Debug
          </button>
          <button
            onClick={loadLeads}
            className="flex items-center gap-1.5 text-xs border border-slate-200 rounded-lg px-3 py-1.5 text-slate-500 hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* ── Region KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {REGIONS.map(region => (
          <RegionCard
            key={region}
            region={region}
            count={data.byRegion[region] || 0}
            total={data.debug.total}
          />
        ))}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
          <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1">Total Leads</div>
          <div className="text-3xl font-black text-slate-800">{data.debug.total}</div>
        </div>
      </div>

      {/* ── Top Cities by Region ── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex border-b border-slate-100">
          {REGIONS.map(r => (
            <button
              key={r}
              onClick={() => setActiveRegionTab(r)}
              className={`px-4 py-3 text-xs font-bold transition-colors ${activeRegionTab === r ? 'border-b-2 border-amber-500 text-amber-700 bg-amber-50' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {r} <span className="ml-1 text-slate-400">({data.byRegion[r] || 0})</span>
            </button>
          ))}
        </div>
        <div className="p-5">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Top Cities</h3>
          <TopCitiesBar
            cities={data.regionCities[activeRegionTab] || {}}
            total={data.byRegion[activeRegionTab] || 1}
          />
        </div>
      </div>

      {/* ── Yearly Totals ── */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4 flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5" /> Yearly Totals
        </h3>
        <div className="space-y-2.5">
          {sortedYears.map(([year, count]) => (
            <div key={year} className="flex items-center gap-3">
              <span className="w-16 text-sm font-bold text-slate-700 text-right">{year}</span>
              <div className="flex-1 h-6 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full flex items-center justify-end pr-2 transition-all"
                  style={{ width: `${Math.max(4, (count / data.debug.total) * 100)}%` }}
                >
                  <span className="text-[10px] font-black text-white">{count}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Monthly Totals + City Expansion ── */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-2">
            <Users className="w-3.5 h-3.5" /> Monthly Breakdown
          </h3>
        </div>
        <div className="divide-y divide-slate-50">
          {sortedMonths.map(monthKey => {
            const count = data.byMonth[monthKey] || 0;
            const expanded = !!expandedMonths[monthKey];
            const cities = data.monthCities[monthKey] || {};

            return (
              <div key={monthKey}>
                {/* Month row */}
                <button
                  onClick={() => toggleMonth(monthKey)}
                  className="w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors text-left"
                >
                  {expanded ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                  <span className="flex-1 text-sm font-semibold text-slate-700">{fmtMonthKey(monthKey)}</span>
                  <span className="text-xs font-black text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">{count}</span>
                </button>

                {/* Cities inside month */}
                {expanded && (
                  <div className="bg-slate-50 divide-y divide-slate-100">
                    {Object.entries(cities)
                      .sort((a, b) => b[1].length - a[1].length)
                      .map(([city, cityLeads]) => {
                        const cityKey = `${monthKey}__${city}`;
                        const cityExpanded = !!expandedMonthCities[cityKey];
                        return (
                          <div key={city}>
                            <button
                              onClick={() => toggleMonthCity(cityKey)}
                              className="w-full flex items-center gap-3 px-8 py-2.5 hover:bg-white transition-colors text-left"
                            >
                              {cityExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />}
                              <MapPin className="w-3 h-3 text-slate-300 flex-shrink-0" />
                              <span className="flex-1 text-xs font-semibold text-slate-600">{city}</span>
                              <span className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full">{cityLeads.length}</span>
                            </button>
                            {/* Lead list inside city */}
                            {cityExpanded && (
                              <div className="px-12 pb-2 space-y-1">
                                {cityLeads.map(lead => (
                                  <a
                                    key={lead.id}
                                    href={`/leads/${lead.id}`}
                                    className="flex items-center gap-2 py-1.5 group"
                                  >
                                    <span className="text-xs text-slate-700 font-medium group-hover:text-amber-700 transition-colors">
                                      {lead.first_name} {lead.last_name}
                                    </span>
                                    {lead.status && (
                                      <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{lead.status}</span>
                                    )}
                                    <span className="text-[10px] text-slate-300 ml-auto">
                                      {lead.created_date ? new Date(lead.created_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                                    </span>
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
          {sortedMonths.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-slate-400">No monthly data available</div>
          )}
        </div>
      </div>

      {/* ── Debug Panel ── */}
      {showDebug && (
        <div className="bg-slate-900 text-green-400 rounded-xl p-5 font-mono text-xs space-y-1">
          <div className="text-green-300 font-bold mb-3">Debug Summary</div>
          <div>Total leads scanned: <span className="text-white font-bold">{data.debug.total}</span></div>
          <div>Total counted: <span className="text-white font-bold">{data.debug.counted}</span></div>
          <div>Unknown city: <span className="text-amber-400 font-bold">{data.debug.unknownCity}</span></div>
          <div>Unknown/needs review region: <span className="text-amber-400 font-bold">{data.debug.unknownRegion}</span></div>
          <div className="pt-2 text-green-300 font-bold">By Region:</div>
          {Object.entries(data.debug.byRegion).map(([r, c]) => (
            <div key={r}>  {r}: <span className="text-white">{c}</span></div>
          ))}
          <div className="pt-2 text-green-300 font-bold">By Year:</div>
          {Object.entries(data.debug.byYear).sort((a,b) => b[0].localeCompare(a[0])).map(([y, c]) => (
            <div key={y}>  {y}: <span className="text-white">{c}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function RegionCard({ region, count, total }) {
  const cfg = {
    'Northern California': { color: 'bg-blue-50 border-blue-200', text: 'text-blue-700', bar: 'bg-blue-500' },
    'Southern California': { color: 'bg-amber-50 border-amber-200', text: 'text-amber-700', bar: 'bg-amber-500' },
    'Needs Region Review': { color: 'bg-red-50 border-red-200', text: 'text-red-600', bar: 'bg-red-400' },
  }[region] || { color: 'bg-slate-50 border-slate-200', text: 'text-slate-600', bar: 'bg-slate-400' };

  const pct = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <div className={`rounded-xl border p-4 ${cfg.color}`}>
      <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${cfg.text}`}>{region}</div>
      <div className={`text-3xl font-black ${cfg.text}`}>{count}</div>
      <div className="mt-2 h-1.5 bg-white/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${cfg.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-slate-400 mt-1">{pct}% of total</div>
    </div>
  );
}

function TopCitiesBar({ cities, total }) {
  const sorted = Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (sorted.length === 0) return <div className="text-sm text-slate-400 py-4">No data</div>;
  const max = sorted[0][1];

  return (
    <div className="space-y-2">
      {sorted.map(([city, count]) => (
        <div key={city} className="flex items-center gap-3">
          <span className="w-36 text-xs font-semibold text-slate-700 truncate text-right">{city}</span>
          <div className="flex-1 h-5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-400 rounded-full flex items-center justify-end pr-2 transition-all"
              style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
            >
              <span className="text-[10px] font-black text-white">{count}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}