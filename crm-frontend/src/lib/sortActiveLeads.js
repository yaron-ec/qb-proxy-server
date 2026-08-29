/**
 * sortActiveLeads
 *
 * Sort by follow_up_date DESC — furthest future first, empty last.
 * No priority boosting for today/overdue/appointment_date.
 */

export function parseFollowUpDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  // Return as local-date numeric: YYYYMMDD integer for clean comparison
  return parseInt(match[1]) * 10000 + parseInt(match[2]) * 100 + parseInt(match[3]);
}

export function getTodayLocal() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

export function sortActiveLeads(leads) {
  return [...leads].sort((a, b) => {
    const tsA = parseFollowUpDate(a.follow_up_date);
    const tsB = parseFollowUpDate(b.follow_up_date);

    // Empty → always last
    if (tsA === null && tsB === null) return 0;
    if (tsA === null) return 1;
    if (tsB === null) return -1;

    // DESC: furthest future first
    return tsB - tsA;
  });
}