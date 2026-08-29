/**
 * leadRegionAnalytics - Load all leads and build region/year/month/city breakdown
 * 
 * Uses pagination to load ALL leads, classifies by region and date,
 * returns nested structure with detailed aggregations
 */

import * as railwayLeads from '@/api/railway/leads';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const NORTHERN_CA = [
  'San Francisco', 'Oakland', 'Berkeley', 'San Jose', 'Palo Alto', 'Sunnyvale',
  'Mountain View', 'Hayward', 'Fremont', 'Daly City', 'Vallejo', 'Concord',
  'Walnut Creek', 'Sacramento', 'Stockton', 'Modesto', 'Merced', 'Fresno',
  'Visalia', 'Bakersfield', 'San Luis Obispo', 'Santa Cruz', 'Salinas',
  'Monterey', 'King City', 'Coalinga', 'Ridgecrest', 'Kern County', 'Tulare County',
  'Inyo County', 'Mono County', 'Kings County', 'Ione', 'Amador'
];

const SOUTHERN_CA = [
  'Los Angeles', 'San Diego', 'Anaheim', 'Long Beach', 'Riverside', 'Irvine',
  'Santa Ana', 'Oxnard', 'Torrance', 'Pasadena', 'Ventura', 'Huntington Beach',
  'Glendale', 'Oceanside', 'Ontario', 'Fontana', 'Santa Barbara', 'Thousand Oaks',
  'Moreno Valley', 'Murrieta', 'Temecula', 'Victorville', 'Palmdale', 'Lancaster',
  'Rancho Cucamonga', 'Corona', 'Costa Mesa', 'Fullerton', 'Norwalk', 'Garden Grove',
  'Huntington Park', 'Santa Monica', 'Malibu', 'Ojai', 'Camarillo', 'Port Hueneme',
  'Simi Valley', 'Agoura Hills', 'Calabasas', 'Westlake Village', 'Newbury Park'
];

function classifyRegion(city) {
  if (!city) return null;
  
  const cityNorm = city.toLowerCase().trim();
  
  if (NORTHERN_CA.some(c => cityNorm.includes(c.toLowerCase()) || c.toLowerCase().includes(cityNorm))) {
    return 'Northern California';
  }
  
  if (SOUTHERN_CA.some(c => cityNorm.includes(c.toLowerCase()) || c.toLowerCase().includes(cityNorm))) {
    return 'Southern California';
  }
  
  return null;
}

function extractDate(lead) {
  // Priority: created_date > date > appointmentDate > followUpDate
  const dateStr = lead.created_date || lead.date || lead.appointmentDate || lead.follow_up_date;
  
  if (!dateStr) return null;
  
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

// Cache: reuse data for 2 minutes, deduplicate concurrent in-flight requests
let _cache = null;
let _cacheAt = 0;
let _inflight = null;
const CACHE_TTL = 2 * 60 * 1000;

async function loadAllLeads() {
  try {
    const res = await railwayLeads.list({ sort: '-created_date', limit: 2000 });
    return res.items || [];
  } catch (e) {
    console.error('[leadRegionAnalytics] Load error:', e.message);
    return [];
  }
}

export async function buildRegionAnalytics() {
  // Return cached result if fresh
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;

  // Deduplicate: if a fetch is already in-flight, wait for it instead of firing another
  if (_inflight) return _inflight;

  console.log('[leadRegionAnalytics] Starting data load...');

  _inflight = (async () => {
  const allLeads = await loadAllLeads();
  console.log(`[leadRegionAnalytics] Total leads loaded: ${allLeads.length}`);

  // Initialize structure
  const data = {};
  
  let unknownCityCount = 0;
  let unknownDateCount = 0;
  const yearCounts = {};

  // Process each lead
  allLeads.forEach(lead => {
    const city = lead.city || null;
    const date = extractDate(lead);

    // Handle missing date — still count for debug
    if (!date) {
      unknownDateCount++;
      return;
    }

    const year = date.getFullYear().toString();
    const monthIndex = date.getMonth();
    const monthName = MONTH_NAMES[monthIndex];

    // Track year counts (all leads with a date, regardless of city)
    if (!yearCounts[year]) yearCounts[year] = 0;
    yearCounts[year]++;

    // Handle missing city OR unclassifiable city — count as Unknown
    const region = classifyRegion(city);
    if (!city || !region) {
      unknownCityCount++;
      // Still add to year structure so totals are accurate
      if (!data[year]) {
        data[year] = {
          'Northern California': { total: 0, months: {}, cities: {} },
          'Southern California': { total: 0, months: {}, cities: {} },
          'Unknown City': { total: 0 },
          'Unknown Date': { total: 0 }
        };
        MONTH_NAMES.forEach(month => {
          data[year]['Northern California'].months[month] = { total: 0, cities: {} };
          data[year]['Southern California'].months[month] = { total: 0, cities: {} };
        });
      }
      data[year]['Unknown City'].total++;
      return;
    }

    // Initialize year
    if (!data[year]) {
      data[year] = {
        'Northern California': { total: 0, months: {}, cities: {} },
        'Southern California': { total: 0, months: {}, cities: {} },
        'Unknown City': { total: 0 },
        'Unknown Date': { total: 0 }
      };

      // Initialize months
      MONTH_NAMES.forEach(month => {
        data[year]['Northern California'].months[month] = { total: 0, cities: {} };
        data[year]['Southern California'].months[month] = { total: 0, cities: {} };
      });
    }

    // Increment region total
    data[year][region].total++;

    // Increment month total
    data[year][region].months[monthName].total++;

    // Track city
    if (!data[year][region].cities[city]) {
      data[year][region].cities[city] = { total: 0, leadIds: [] };
    }
    data[year][region].cities[city].total++;
    data[year][region].cities[city].leadIds.push(lead.id);

    // Track city in month
    if (!data[year][region].months[monthName].cities[city]) {
      data[year][region].months[monthName].cities[city] = { total: 0, leadIds: [] };
    }
    data[year][region].months[monthName].cities[city].total++;
    data[year][region].months[monthName].cities[city].leadIds.push(lead.id);
  });

  // Log debug info
  console.log('[leadRegionAnalytics] Debug Summary:');
  console.log(`  Total leads loaded: ${allLeads.length}`);
  console.log(`  Unknown city: ${unknownCityCount}`);
  console.log(`  Unknown date: ${unknownDateCount}`);
  Object.entries(yearCounts).forEach(([year, count]) => {
    console.log(`  Leads in ${year}: ${count}`);
  });

  const result = {
    data,
    debug: {
      totalLeads: allLeads.length,
      unknownCity: unknownCityCount,
      unknownDate: unknownDateCount,
      yearCounts
    }
  };

  _cache = result;
  _cacheAt = Date.now();
  _inflight = null;
  return result;
  })();

  return _inflight;
}