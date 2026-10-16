/**
 * appleMapsDirections.js — Apple Maps directions link for My Day's
 * "Directions"/"Navigate" actions (MobileDayView.jsx and its embedded Map
 * view, components/dailymap/{MapView,AppointmentList}.jsx).
 *
 * Scoped to My Day only. Other parts of the CRM (e.g. Lead Detail's
 * lib/addressActions.js) still link to Google Maps and are intentionally
 * unaffected — this is a separate helper, not a shared one, so a future
 * change to one never silently changes the other.
 *
 * https://maps.apple.com/?daddr=...&dirflg=d is Apple's official universal
 * web link for driving directions: it deep-links into the Apple Maps app on
 * iPhone/iPad and opens Apple Maps on the web (maps.apple.com) in a desktop
 * browser. The maps:// custom URL scheme was deliberately NOT used — it
 * only resolves on Apple's own platforms and fails silently (dead link, no
 * fallback) on Android or in a desktop browser.
 */

/**
 * destination: either "lat,lng" (preferred — exact pin) or a free-text
 * address string. Returns null for a missing/blank destination so callers
 * can safely hide the action rather than link to an empty/invalid query.
 */
export function getAppleMapsDirectionsUrl(destination) {
  const dest = typeof destination === 'string' ? destination.trim() : '';
  if (!dest) return null;
  return `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=d`;
}

/** "lat,lng" destination from a {lat, lng} pair, or null if either is missing/invalid. */
export function getAppleMapsDirectionsUrlFromCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return getAppleMapsDirectionsUrl(`${lat},${lng}`);
}
