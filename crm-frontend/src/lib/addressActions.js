/**
 * addressActions.js — Google Maps link helpers for a Lead's verified address.
 *
 * Deliberately thin: no geocoding happens here. It only builds URLs from
 * coordinates/addresses ALREADY resolved by the one canonical pipeline
 * (lib/addressPipeline.js + lib/googleMapsClient.js on the backend, exposed
 * on the lead as property_lat/property_lng/verified_property_address/
 * property_geocode_status). This is the same coordinate data My Day's Map
 * view and the daily routing calculation (routes/routing.js) consume — never
 * a second, independent address interpretation.
 */

export function getFullAddress(lead) {
  return [lead?.property_address, lead?.city, lead?.state, lead?.zip].filter(Boolean).join(', ');
}

/** Google Maps directions to this lead's resolved location, or its raw address as a fallback. */
export function getDirectionsUrl(lead) {
  const dest = (lead?.property_lat != null && lead?.property_lng != null)
    ? `${lead.property_lat},${lead.property_lng}`
    : (lead?.verified_property_address || getFullAddress(lead));
  if (!dest) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

/**
 * "View Property" — opens Google Maps' Street View panorama closest to the
 * resolved coordinates. Only offered when we have real coordinates (never
 * fabricated for an unverified/ungeocoded address). If Google has no Street
 * View imagery at this exact point, Maps itself falls back to a normal map
 * view of the location — that's standard Google Maps behavior, not a broken
 * link, so this never claims guaranteed imagery.
 */
export function getPropertyViewUrl(lead) {
  if (lead?.property_lat == null || lead?.property_lng == null) return null;
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lead.property_lat},${lead.property_lng}`;
}
