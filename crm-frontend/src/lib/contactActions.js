/**
 * contactActions.js
 *
 * Unified click-to-call, click-to-SMS, click-to-email helpers.
 *
 * Mobile (iPhone Safari / Android Chrome):
 *   - Call: tel: link — opens native dialer directly
 *   - SMS:  sms: link — opens native Messages app
 *   - Email: mailto: link — opens native Mail / Gmail app
 *
 * Desktop:
 *   - tel: / sms: hand off to Phone Hub / Handoff / Windows Phone Link
 *   - Email: opens Gmail web compose in a new tab
 *
 * IMPORTANT: On mobile, never use window.open() for tel:/sms: — it gets
 * blocked by Safari/Chrome popup blockers. Always use direct href assignment
 * or an <a> tag with the correct href.
 */

/** Strip non-digits, return E.164-ish string safe for tel: URIs */
function toDialable(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits ? `+${digits}` : '';
}

function isMobile() {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Initiate a phone call.
 * On mobile: direct location.href to avoid popup blocker.
 * On desktop: window.open so Phone Hub can intercept without navigating.
 */
export function callPhone(phone, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const dialable = toDialable(phone);
  if (!dialable) return;
  if (isMobile()) {
    window.location.href = `tel:${dialable}`;
  } else {
    const w = window.open(`tel:${dialable}`, '_blank');
    if (!w) window.location.href = `tel:${dialable}`;
  }
}

/**
 * Open native SMS composer.
 * On mobile: direct location.href — popup blocker safe.
 * On desktop: window.open for Phone Hub / Handoff.
 */
export function sendSMS(phone, body, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const dialable = toDialable(phone);
  if (!dialable) return;
  const encoded = body ? `?body=${encodeURIComponent(body)}` : '';
  const uri = `sms:${dialable}${encoded}`;
  if (isMobile()) {
    window.location.href = uri;
  } else {
    const w = window.open(uri, '_blank');
    if (!w) window.location.href = uri;
  }
}

/**
 * Open email composer.
 * On mobile: mailto: — opens native Mail / Gmail app.
 * On desktop: Gmail web compose in a new tab.
 */
export function composeEmail(email, e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!email) return;
  if (isMobile()) {
    window.location.href = `mailto:${encodeURIComponent(email)}`;
  } else {
    window.open(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`,
      '_blank',
      'noopener'
    );
  }
}

/** Returns true if the current device is likely mobile */
export function isMobileDevice() {
  return isMobile();
}