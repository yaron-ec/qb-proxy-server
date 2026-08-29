/**
 * regionClassifier - Dynamically classify leads by California region
 * 
 * Northern California: Fresno, Bakersfield, and anything north
 * Southern California: anything south of Bakersfield
 */

const NORTHERN_CA_CITIES = [
  'San Francisco', 'Oakland', 'Berkeley', 'San Jose', 'Palo Alto', 'Sunnyvale', 
  'Mountain View', 'Hayward', 'Fremont', 'Daly City', 'Vallejo', 'Concord', 
  'Walnut Creek', 'Sacramento', 'Stockton', 'Modesto', 'Merced', 'Fresno', 
  'Visalia', 'Bakersfield', 'San Luis Obispo', 'Santa Cruz', 'Salinas',
  'Monterey', 'King City', 'Coalinga', 'Ridgecrest', 'Kern County', 'Tulare County',
  'Inyo County', 'Mono County', 'Kings County', 'Ione', 'Amador'
];

const SOUTHERN_CA_CITIES = [
  'Los Angeles', 'San Diego', 'Anaheim', 'Long Beach', 'Riverside', 'Irvine', 
  'Santa Ana', 'Oxnard', 'Torrance', 'Pasadena', 'Ventura', 'Huntington Beach',
  'Glendale', 'Oceanside', 'Ontario', 'Fontana', 'Santa Barbara', 'Thousand Oaks',
  'Moreno Valley', 'Murrieta', 'Temecula', 'Victorville', 'Palmdale', 'Lancaster',
  'Rancho Cucamonga', 'Corona', 'Costa Mesa', 'Fullerton', 'Norwalk', 'Garden Grove',
  'Huntington Park', 'Santa Monica', 'Malibu', 'Ojai', 'Camarillo', 'Port Hueneme',
  'Simi Valley', 'Agoura Hills', 'Calabasas', 'Westlake Village', 'Newbury Park',
  'Ridgecrest', 'Rosamond'
];

export function classifyRegion(city) {
  if (!city) return 'Unknown City';
  
  const cityNorm = city.toLowerCase().trim();
  
  // Check Northern CA
  if (NORTHERN_CA_CITIES.some(c => cityNorm.includes(c.toLowerCase()) || c.toLowerCase().includes(cityNorm))) {
    return 'Northern California';
  }
  
  // Check Southern CA
  if (SOUTHERN_CA_CITIES.some(c => cityNorm.includes(c.toLowerCase()) || c.toLowerCase().includes(cityNorm))) {
    return 'Southern California';
  }
  
  // If city looks like a county or other region, try fuzzy matching
  const allCities = [...NORTHERN_CA_CITIES, ...SOUTHERN_CA_CITIES];
  const matches = allCities.filter(c => {
    const dist = levenshteinDistance(cityNorm, c.toLowerCase());
    return dist <= 2; // Allow for 2-char typos
  });
  
  if (matches.length > 0) {
    return NORTHERN_CA_CITIES.includes(matches[0]) ? 'Northern California' : 'Southern California';
  }
  
  return 'Needs Region Review';
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  
  return matrix[b.length][a.length];
}

export function getLeadsByRegionYearMonth(leads) {
  const data = {};
  
  leads.forEach(lead => {
    const region = classifyRegion(lead.city);
    const year = lead.created_date ? new Date(lead.created_date).getFullYear().toString() : 'Unknown';
    const month = lead.created_date ? String(new Date(lead.created_date).getMonth() + 1).padStart(2, '0') : '00';
    const monthKey = `${year}-${month}`;
    
    if (!data[region]) data[region] = {};
    if (!data[region][monthKey]) data[region][monthKey] = [];
    data[region][monthKey].push(lead);
  });
  
  return data;
}

export function getLeadsByRegionCity(leads, region) {
  const cityMap = {};
  
  leads
    .filter(lead => classifyRegion(lead.city) === region)
    .forEach(lead => {
      const city = lead.city || 'Unknown City';
      if (!cityMap[city]) cityMap[city] = [];
      cityMap[city].push(lead);
    });
  
  return cityMap;
}