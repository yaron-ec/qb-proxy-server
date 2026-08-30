/* eslint-disable no-undef */
/**
 * Branded, mobile-friendly, WCAG-AA customer action pages for the EC
 * Construction Group reminder system.
 *
 * Pure functions: all data (rep, appointment) is passed in from the router,
 * sourced from the token's stored snapshot — these pages NEVER read Base44.
 *
 * Accessibility (WCAG 2.1 AA): semantic landmarks, skip link, visible
 * :focus-visible, <label for>, aria-labels, 48px tap targets, navy/gold
 * palette (gold only for borders/accents, never small text).
 *
 * Future-ready (no routing changes): STRINGS map for Spanish/Hebrew,
 * repContactCard can later add SMS / .ics / calendar buttons.
 */
'use strict';

const LOGO_URL = `${process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com'}/email-logo.png`;
const NAVY = '#0B2D5C';
const GOLD = '#C9A227';
const BG = '#EEF1F7';
const LIGHT = '#F4F6FA';
const TEXT = '#1A1A2E';
const MUTED = '#6B7280';

function publicUrl() { return (process.env.REMINDER_PUBLIC_URL || '').replace(/\/$/, ''); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PAGE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:${BG};color:${TEXT};padding:24px 16px;-webkit-font-smoothing:antialiased;line-height:1.6;}
  .wrapper{max-width:600px;margin:0 auto;}
  .card{background:#fff;border-radius:12px;margin-bottom:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);}
  .header{background:#fff;padding:28px 24px 20px;text-align:center;border-bottom:3px solid ${GOLD};}
  .header img{max-width:220px;height:auto;}
  .pad{padding:28px 24px;}
  h1{font-size:24px;font-weight:800;color:${NAVY};letter-spacing:-.3px;margin-bottom:8px;}
  h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${NAVY};margin-bottom:14px;}
  p.lead{font-size:16px;color:${TEXT};margin-bottom:20px;}
  p.muted{font-size:14px;color:${MUTED};margin-bottom:16px;}
  .summary{background:${LIGHT};border-radius:10px;border-left:4px solid ${GOLD};padding:18px 20px;margin:18px 0;}
  .summary .row{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #DDE3EE;}
  .summary .row:last-child{border-bottom:none;}
  .summary .lbl{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};width:120px;flex-shrink:0;padding-top:2px;}
  .summary .val{font-size:15px;font-weight:600;color:${TEXT};flex:1;}
  .check{width:64px;height:64px;border-radius:50%;background:${NAVY};color:#fff;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 16px;}
  .btn{display:block;width:100%;min-height:48px;border:none;border-radius:8px;padding:15px 20px;font-size:15px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer;margin-bottom:10px;font-family:inherit;}
  .btn-primary{background:${NAVY};color:#fff;}
  .btn-outline{background:#fff;color:${NAVY};border:2px solid ${NAVY};}
  .btn-gold{background:#fff;color:${NAVY};border:2px solid ${GOLD};}
  .btn:focus-visible{outline:3px solid ${GOLD};outline-offset:2px;}
  label.field{display:block;font-size:13px;font-weight:700;color:${NAVY};margin:14px 0 6px;}
  input[type=date],input[type=time],textarea{width:100%;min-height:48px;border:2px solid #DDE3EE;border-radius:8px;padding:12px 14px;font-size:16px;font-family:inherit;color:${TEXT};background:#fff;}
  input:focus,textarea:focus{outline:3px solid ${GOLD};outline-offset:1px;border-color:${NAVY};}
  textarea{min-height:96px;resize:vertical;}
  .error{background:#FDECEC;border:1px solid #F2B8B8;color:#9B1C1C;border-radius:8px;padding:12px 14px;font-size:14px;margin:12px 0;}
  .rep-name{font-size:18px;font-weight:800;color:${NAVY};margin-bottom:6px;}
  .rep-line{font-size:14px;color:${TEXT};margin:4px 0;}
  .rep-line .k{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${MUTED};display:inline-block;width:110px;}
  .rep-line a{color:${NAVY};text-decoration:none;font-weight:600;}
  .footer{background:${NAVY};border-radius:0 0 12px 12px;padding:22px 24px;text-align:center;}
  .footer .co{font-size:15px;font-weight:700;color:${GOLD};margin-bottom:4px;}
  .footer .tg{font-size:12px;color:rgba(255,255,255,.75);line-height:1.7;}
  .footer .tg a{color:${GOLD};text-decoration:none;}
  .skip{position:absolute;left:-9999px;}
  .skip:focus{left:16px;top:16px;background:#fff;padding:8px 12px;border-radius:6px;z-index:9;}
  @media(max-width:480px){.summary .lbl{width:96px;font-size:11px;}}
`;

const S = {
  skip: 'Skip to content', officePhone: '(310) 310-4108', officeEmail: 'office@ecconstructiongroup.com',
  footerTagline: 'Licensed & Insured · Serving Southern & Northern California',
  confirmTitle: 'Confirm Your Appointment', confirmedTitle: 'Your Appointment Is Confirmed',
  alreadyConfirmedTitle: 'This Appointment Is Already Confirmed',
  rescheduleTitle: 'Request a Reschedule', rescheduleReceivedTitle: 'Your Reschedule Request Has Been Received',
  alreadyReceivedTitle: 'This Request Was Already Received',
  contactTitle: 'Contact Your Sales Representative',
  changedTitle: 'Your Appointment Details Have Changed',
  expiredTitle: 'This Link Has Expired', invalidTitle: 'This Link Is Invalid',
  changesNote: 'If you need to make any changes before your appointment, you can contact your representative below.',
  alreadyConfirmedNote: 'You have already confirmed this appointment. No further action is needed.',
  dateLabel: 'Date', timeLabel: 'Time', addressLabel: 'Address', repLabel: 'Representative',
  preferredDate: 'Preferred date', preferredTime: 'Preferred time', noteLabel: 'Note (optional)',
  noteHint: 'e.g. "I\'ll be home after 3 PM."', submit: 'Submit Request',
  callRep: 'Call Representative', emailRep: 'Email Representative', callOffice: 'Call Office', emailOffice: 'Email Office',
  changedBody: 'The details of this appointment have changed since we sent this link. For your security, this link no longer applies. Please contact EC Construction Group and we will be happy to help you.',
  expiredBody: 'For your security, this link has expired. Please contact EC Construction Group and we will be happy to help you.',
  invalidBody: 'We could not verify this link. Please contact EC Construction Group for assistance.',
  repName: 'Sales Representative', directLine: 'Direct line', email: 'Email', office: 'Office',
};

function shell(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <a class="skip" href="#main">${esc(S.skip)}</a>
  <div class="wrapper">
    <div class="card">
      <div class="header"><img src="${LOGO_URL}" alt="EC Construction Group"></div>
      <main id="main" class="pad">${inner}</main>
    </div>
    <div class="footer">
      <div class="co">EC Construction Group</div>
      <div class="tg">${esc(S.footerTagline)}<br><a href="tel:3103104108">${esc(S.officePhone)}</a> · <a href="mailto:${esc(S.officeEmail)}">${esc(S.officeEmail)}</a></div>
    </div>
  </div>
</body>
</html>`;
}

function apptCard(appt) {
  const rows = [
    { l: S.dateLabel, v: appt.date }, { l: S.timeLabel, v: appt.time },
    appt.address ? { l: S.addressLabel, v: appt.address } : null,
  ].filter(Boolean).map(r => `<div class="row"><span class="lbl">${esc(r.l)}</span><span class="val">${esc(r.v)}</span></div>`).join('');
  return `<div class="summary">${rows}</div>`;
}

function repContactCard(rep, rawToken) {
  const base = publicUrl();
  const click = (btn) => `${base}/r/click/${encodeURIComponent(rawToken)}?btn=${btn}`;
  return `<section class="card" aria-label="${esc(S.contactTitle)}">
    <div class="pad">
      <h2>${esc(S.repName)}</h2>
      <div class="rep-name">${esc(rep.name)}</div>
      <div class="rep-line"><span class="k">${esc(S.directLine)}</span><a href="tel:${esc(String(rep.directPhone).replace(/[^\d+]/g, ''))}">${esc(rep.directPhone)}</a></div>
      <div class="rep-line"><span class="k">${esc(S.email)}</span><a href="mailto:${esc(rep.email)}">${esc(rep.email)}</a></div>
      <div class="rep-line"><span class="k">${esc(S.office)}</span>${esc(rep.officePhone)}</div>
      <div class="rep-line"><span class="k">${esc(S.email)}</span><a href="mailto:${esc(rep.officeEmail)}">${esc(rep.officeEmail)}</a></div>
      <div style="margin-top:18px;">
        <a class="btn btn-primary" href="${esc(click('call_rep'))}" aria-label="${esc(S.callRep)}: ${esc(rep.name)}">📞 ${esc(S.callRep)}</a>
        <a class="btn btn-outline" href="${esc(click('email_rep'))}" aria-label="${esc(S.emailRep)}: ${esc(rep.name)}">✉️ ${esc(S.emailRep)}</a>
        <a class="btn btn-gold" href="${esc(click('call_office'))}" aria-label="${esc(S.callOffice)}">📞 ${esc(S.callOffice)}</a>
        <a class="btn btn-gold" href="${esc(click('email_office'))}" aria-label="${esc(S.emailOffice)}">✉️ ${esc(S.emailOffice)}</a>
      </div>
    </div>
  </section>`;
}

function confirmFormPage({ rep, appt, token, nonce }) {
  return shell(S.confirmTitle, `
    <h1>${esc(S.confirmTitle)}</h1>
    <p class="lead">Please confirm the appointment details below.</p>
    ${apptCard(appt)}
    <form action="/r/confirm/${encodeURIComponent(token)}" method="post" style="margin-top:18px;">
      <input type="hidden" name="nonce" value="${esc(nonce)}">
      <button type="submit" class="btn btn-primary" aria-label="${esc(S.confirmTitle)}">✓ Confirm Appointment</button>
    </form>
    <p class="muted" style="margin-top:14px;">${esc(S.changesNote)}</p>
    ${repContactCard(rep, token)}
  `);
}

function confirmedPage({ rep, appt, rawToken }) {
  return shell(S.confirmedTitle, `
    <div class="check" aria-hidden="true">✓</div>
    <h1>${esc(S.confirmedTitle)}</h1>
    <p class="lead">${esc(S.changesNote)}</p>
    ${apptCard(appt)}
    ${repContactCard(rep, rawToken)}
  `);
}

function alreadyConfirmedPage({ rep, appt, rawToken }) {
  return shell(S.alreadyConfirmedTitle, `
    <div class="check" aria-hidden="true">✓</div>
    <h1>${esc(S.alreadyConfirmedTitle)}</h1>
    <p class="lead">${esc(S.alreadyConfirmedNote)}</p>
    ${apptCard(appt)}
    <p class="muted">${esc(S.changesNote)}</p>
    ${repContactCard(rep, rawToken)}
  `);
}

function rescheduleFormPage({ rep, appt, token, nonce, error }) {
  const today = new Date().toISOString().slice(0, 10);
  return shell(S.rescheduleTitle, `
    <h1>${esc(S.rescheduleTitle)}</h1>
    <p class="lead">Request a new date or time. We will not change your appointment automatically — your representative will reach out to finalize.</p>
    ${apptCard(appt)}
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form action="/r/reschedule/${encodeURIComponent(token)}" method="post" style="margin-top:8px;">
      <input type="hidden" name="nonce" value="${esc(nonce)}">
      <label class="field" for="date">${esc(S.preferredDate)}</label>
      <input type="date" id="date" name="date" min="${esc(today)}" required autocomplete="off">
      <label class="field" for="time">${esc(S.preferredTime)}</label>
      <input type="time" id="time" name="time" required autocomplete="off">
      <label class="field" for="note">${esc(S.noteLabel)}</label>
      <textarea id="note" name="note" maxlength="500" placeholder="${esc(S.noteHint)}" aria-describedby="notehint"></textarea>
      <p class="muted" id="notehint" style="font-size:12px;margin-top:4px;">${esc(S.noteHint)}</p>
      <button type="submit" class="btn btn-primary" style="margin-top:10px;">${esc(S.submit)}</button>
    </form>
    ${repContactCard(rep, token)}
  `);
}

function rescheduleReceivedPage({ rep, appt, rawToken, requestedDate, requestedTime }) {
  return shell(S.rescheduleReceivedTitle, `
    <div class="check" aria-hidden="true">✓</div>
    <h1>${esc(S.rescheduleReceivedTitle)}</h1>
    <p class="lead">We received your request for <strong>${esc(requestedDate)}</strong> at <strong>${esc(requestedTime)}</strong>. Your representative will contact you shortly to confirm the new time.</p>
    ${apptCard(appt)}
    <p class="muted">${esc(S.changesNote)}</p>
    ${repContactCard(rep, rawToken)}
  `);
}

function alreadySubmittedPage({ rep, appt, rawToken, requestedDate, requestedTime }) {
  return shell(S.alreadyReceivedTitle, `
    <div class="check" aria-hidden="true">✓</div>
    <h1>${esc(S.alreadyReceivedTitle)}</h1>
    <p class="lead">You already submitted this request for <strong>${esc(requestedDate)}</strong> at <strong>${esc(requestedTime)}</strong>. No need to submit it again — your representative will reach out.</p>
    ${apptCard(appt)}
    <p class="muted">${esc(S.changesNote)}</p>
    ${repContactCard(rep, rawToken)}
  `);
}

function contactPage({ rep, rawToken }) {
  return shell(S.contactTitle, `
    <h1>${esc(S.contactTitle)}</h1>
    <p class="lead">Reach your representative or our office directly below.</p>
    ${repContactCard(rep, rawToken)}
  `);
}

function appointmentChangedPage() {
  return shell(S.changedTitle, `
    <h1>${esc(S.changedTitle)}</h1>
    <p class="lead">${esc(S.changedBody)}</p>
    <a class="btn btn-primary" href="tel:3103104108">📞 ${esc(S.callOffice)}</a>
    <a class="btn btn-outline" href="mailto:${esc(S.officeEmail)}">✉️ ${esc(S.emailOffice)}</a>
  `);
}

function expiredPage() {
  return shell(S.expiredTitle, `
    <h1>${esc(S.expiredTitle)}</h1>
    <p class="lead">${esc(S.expiredBody)}</p>
    <a class="btn btn-primary" href="tel:3103104108">📞 ${esc(S.callOffice)}</a>
    <a class="btn btn-outline" href="mailto:${esc(S.officeEmail)}">✉️ ${esc(S.emailOffice)}</a>
  `);
}

function invalidPage() {
  return shell(S.invalidTitle, `
    <h1>${esc(S.invalidTitle)}</h1>
    <p class="lead">${esc(S.invalidBody)}</p>
    <a class="btn btn-primary" href="tel:3103104108">📞 ${esc(S.callOffice)}</a>
    <a class="btn btn-outline" href="mailto:${esc(S.officeEmail)}">✉️ ${esc(S.emailOffice)}</a>
  `);
}

module.exports = {
  confirmFormPage, confirmedPage, alreadyConfirmedPage,
  rescheduleFormPage, rescheduleReceivedPage, alreadySubmittedPage,
  contactPage, appointmentChangedPage, expiredPage, invalidPage,
};