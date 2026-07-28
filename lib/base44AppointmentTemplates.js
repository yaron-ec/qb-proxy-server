/* eslint-disable no-undef */
/**
 * base44AppointmentTemplates — EXACT CommonJS port of the template functions
 * in base44/functions/sendAppointmentReminder/entry.ts, used ONLY by the parity
 * test (test/reminderParity.test.js) to prove the Railway reminderEmails.js
 * templates produce byte-identical output.
 *
 * This file is a frozen reference copied verbatim from the live Base44 function
 * (do not "improve" it). If the Base44 function changes, update this reference
 * and re-run the parity test before any Railway cutover.
 *
 * Differences vs the Base44 Deno source are limited to runtime shims:
 *   - `Deno.env.get` -> `process.env`
 *   - `btoa(unescape(encodeURIComponent(...)))` -> `Buffer.from(...,'utf8').toString('base64')`
 *   - CommonJS module.exports
 * The HTML/CSS/copy are unchanged.
 */
'use strict';

const COMPANY_NAME = 'EC Construction Group';
const LOGO_URL = 'https://media.base44.com/images/public/69f42cee41d29f30bff5c013/cc5db7058_image.png';
const NAVY = '#0B2D5C';
const GOLD = '#C9A227';
const LIGHT_GRAY = '#F4F6FA';
const TEXT_DARK = '#1A1A2E';
const TEXT_MUTED = '#6B7280';
const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background-color: #EEF1F7; color: ${TEXT_DARK}; padding: 32px 16px;
    -webkit-font-smoothing: antialiased;
  }
  .wrapper { max-width: 650px; margin: 0 auto; }
  .header { background:#fff; border-radius:12px 12px 0 0; padding:36px 48px 28px; text-align:center; border-bottom:3px solid ${GOLD}; }
  .header img { max-width:260px; height:auto; display:block; margin:0 auto; }
  .body { background:#fff; padding:40px 48px; }
  .email-title { font-size:22px; font-weight:700; color:${NAVY}; letter-spacing:-0.3px; margin-bottom:6px; }
  .email-subtitle { font-size:14px; color:${TEXT_MUTED}; margin-bottom:28px; }
  .greeting { font-size:16px; color:${TEXT_DARK}; margin-bottom:24px; line-height:1.7; }
  .summary-card { background:${LIGHT_GRAY}; border-radius:10px; border-left:4px solid ${GOLD}; padding:24px 28px; margin:24px 0; }
  .summary-card-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:${GOLD}; margin-bottom:16px; }
  .summary-row { display:flex; align-items:flex-start; padding:10px 0; border-bottom:1px solid #DDE3EE; }
  .summary-row:last-child { border-bottom:none; }
  .summary-label { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.8px; color:${TEXT_MUTED}; width:140px; flex-shrink:0; padding-top:1px; }
  .summary-value { font-size:15px; font-weight:500; color:${TEXT_DARK}; flex:1; }
  .notice-box { background:#FFF9EC; border:1px solid #F0D98A; border-radius:8px; padding:16px 20px; margin:24px 0; font-size:14px; color:#7A5C00; line-height:1.6; }
  .notice-box strong { color:#5C4400; }
  .cta-wrapper { text-align:center; margin:32px 0 28px; }
  .cta-button { display:inline-block; background:${NAVY}; color:#fff !important; text-decoration:none; font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; padding:16px 40px; border-radius:6px; }
  .contact-section { background:${LIGHT_GRAY}; border-radius:8px; padding:20px 24px; margin-top:28px; }
  .contact-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:${TEXT_MUTED}; margin-bottom:12px; }
  .contact-row { font-size:13px; color:${TEXT_DARK}; line-height:2; }
  .contact-row a { color:${NAVY}; text-decoration:none; font-weight:500; }
  .footer { background:${NAVY}; border-radius:0 0 12px 12px; padding:28px 48px; text-align:center; }
  .footer-company { font-size:15px; font-weight:700; color:${GOLD}; letter-spacing:0.5px; margin-bottom:6px; }
  .footer-tagline { font-size:12px; color:rgba(255,255,255,0.65); line-height:1.8; }
  .footer-tagline a { color:${GOLD}; text-decoration:none; }
  @media (max-width:600px) {
    .header, .body { padding-left:24px !important; padding-right:24px !important; }
    .footer { padding-left:24px !important; padding-right:24px !important; }
    .summary-label { width:100px; font-size:11px; }
    .cta-button { padding:14px 28px; font-size:12px; }
  }
`;

function buildEmail(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <img src="${LOGO_URL}" alt="EC Construction Group">
    </div>
    <div class="body">
      ${inner}
      <div class="contact-section">
        <div class="contact-title">Get In Touch</div>
        <div class="contact-row">
          📞 <a href="tel:3103104108">(310) 310-4108</a><br>
          ✉️ <a href="mailto:office@ecconstructiongroup.com">office@ecconstructiongroup.com</a><br>
          🌐 <a href="https://ecconstructiongroup.com">ecconstructiongroup.com</a>
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="footer-company">EC Construction Group</div>
      <div class="footer-tagline">
        Licensed &amp; Insured &nbsp;·&nbsp; Serving Southern &amp; Northern California<br>
        <a href="https://ecconstructiongroup.com">ecconstructiongroup.com</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function summaryRows(rows) {
  return rows.filter(r => r.value).map(r => `
    <div class="summary-row">
      <span class="summary-label">${r.label}</span>
      <span class="summary-value">${r.value}</span>
    </div>`).join('');
}

function projectInfoCard(address, projectType) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        ${address ? `
        <td width="48%" style="background:#0B2D5C;border-radius:10px;padding:20px 22px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#C9A227;margin-bottom:10px;">📍 Property Address</div>
          <div style="font-size:15px;font-weight:600;color:#ffffff;line-height:1.5;">${address}</div>
        </td>
        ` : ''}
        ${address && projectType ? `<td width="4%"></td>` : ''}
        ${projectType ? `
        <td width="48%" style="background:#C9A227;border-radius:10px;padding:20px 22px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#0B2D5C;margin-bottom:10px;">🏗️ Project Type</div>
          <div style="font-size:15px;font-weight:600;color:#0B2D5C;line-height:1.5;">${projectType}</div>
        </td>
        ` : ''}
      </tr>
    </table>`;
}

function clientMeetingEmail({ firstName, date, time, address, projectType, ownerName, label, isCatchUp }) {
  const subtitle = isCatchUp
    ? `Your appointment is confirmed — here are the details`
    : `Your appointment is in <strong>${label}</strong>`;
  return buildEmail(`Appointment Reminder — ${COMPANY_NAME}`, `
    <div class="email-title">Upcoming Appointment ${isCatchUp ? 'Confirmation' : 'Reminder'}</div>
    <div class="email-subtitle">${subtitle}</div>
    <div class="greeting">
      Hi ${firstName},<br><br>
      This is a ${isCatchUp ? 'confirmation' : 'friendly reminder'} from <strong>${ownerName}</strong> at EC Construction Group.
      We're looking forward to meeting with you soon.
    </div>
    ${projectInfoCard(address, projectType)}
    <div class="summary-card">
      <div class="summary-card-title">Appointment Details</div>
      ${summaryRows([
        { label: '📅 Date', value: date },
        { label: '⏰ Time', value: time },
        { label: '👤 Representative', value: ownerName },
      ])}
    </div>
    <div class="notice-box">
      <strong>Important:</strong> Please ensure all decision makers are present during the appointment.
      If you need to reschedule, contact us at least 24 hours in advance.
    </div>
    <div class="cta-wrapper">
      <a href="https://ecconstructiongroup.com" class="cta-button">View Our Work</a>
    </div>
    <p style="font-size:14px;color:${TEXT_MUTED};line-height:1.7;margin-top:16px;">
      We look forward to discussing your project. See you soon!<br><br>
      Warm regards,<br>
      <strong style="color:${NAVY}">${ownerName}</strong><br>
      <span style="color:${TEXT_MUTED}">EC Construction Group</span>
    </p>
  `);
}

function clientPhoneCallEmail({ firstName, date, time, phone, projectType, ownerName, label, address, isCatchUp }) {
  const subtitle = isCatchUp
    ? `Your call is confirmed — here are the details`
    : `Your call is scheduled in <strong>${label}</strong>`;
  return buildEmail(`Phone Call Reminder — ${COMPANY_NAME}`, `
    <div class="email-title">Phone Call ${isCatchUp ? 'Confirmation' : 'Reminder'}</div>
    <div class="email-subtitle">${subtitle}</div>
    <div class="greeting">
      Hi ${firstName},<br><br>
      This is a ${isCatchUp ? 'confirmation' : 'reminder'} that <strong>${ownerName}</strong> from EC Construction Group will be calling you soon.
      Please make sure you're available at the number below.
    </div>
    ${projectInfoCard(address, projectType)}
    <div class="summary-card">
      <div class="summary-card-title">Call Details</div>
      ${summaryRows([
        { label: '📅 Date', value: date },
        { label: '⏰ Time', value: time },
        { label: "📞 We'll Call", value: phone },
        { label: '👤 Representative', value: ownerName },
      ])}
    </div>
    <div class="notice-box">
      <strong>Please be available</strong> at the number listed above.
      If you need to reschedule, contact us at (310) 310-4108.
    </div>
    <p style="font-size:14px;color:${TEXT_MUTED};line-height:1.7;margin-top:24px;">
      Talk to you soon!<br><br>
      Warm regards,<br>
      <strong style="color:${NAVY}">${ownerName}</strong><br>
      <span style="color:${TEXT_MUTED}">EC Construction Group</span>
    </p>
  `);
}

function repReminderEmail({ ownerName, clientName, clientPhone, clientEmail, date, time, address, projectType, budget, notes, label, leadId, isPhoneCall, isCatchUp }) {
  const mapsUrl = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  const notesHtml = notes ? `
    <div style="background:#F0F4FF;border-left:4px solid #3B5FC0;border-radius:8px;padding:20px 24px;margin:24px 0;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#3B5FC0;margin-bottom:10px;">📝 Consultation Request / Notes</div>
      <div style="font-size:14px;color:#1A1A2E;line-height:1.8;white-space:pre-wrap;">${notes}</div>
    </div>` : '';
  const mapsButton = mapsUrl ? `
    <a href="${mapsUrl}" style="display:inline-block;background:#ffffff;color:${NAVY} !important;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 28px;border-radius:6px;border:2px solid ${NAVY};margin-left:12px;">📍 Open in Google Maps</a>` : '';
  const titleVerb = isCatchUp ? 'New Appointment Scheduled' : `${isPhoneCall ? 'Phone Call' : 'Appointment'} in ${label}`;
  return buildEmail(`${titleVerb}: ${clientName}`, `
    <div class="email-title">${isCatchUp ? '📅 New Appointment Scheduled' : `Upcoming ${isPhoneCall ? 'Phone Call' : 'Appointment'} Reminder`}</div>
    <div class="email-subtitle">${isCatchUp ? 'Appointment created — next available reminder sent' : `${isPhoneCall ? 'Phone call' : 'Appointment'} in <strong>${label}</strong>`} — EC Construction Group CRM</div>
    <div class="greeting">
      Hello ${ownerName},<br><br>
      ${isCatchUp
        ? `A new appointment has been scheduled with the customer below. Please review the details and prepare for your ${isPhoneCall ? 'call' : 'visit'}.`
        : `This is a reminder that you have an upcoming ${isPhoneCall ? 'phone call' : 'appointment'} scheduled with the following customer. Please review the details below before your ${isPhoneCall ? 'call' : 'visit'}.`
      }
    </div>
    <div style="background:${LIGHT_GRAY};border-radius:10px;border-left:4px solid ${GOLD};padding:24px 28px;margin:24px 0;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:${GOLD};margin-bottom:20px;">Customer & Appointment Details</div>
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">👤 Customer</span>
        <span style="font-size:15px;font-weight:700;color:${NAVY};">${clientName}</span>
      </div>
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">📅 Date</span>
        <span style="font-size:15px;font-weight:700;color:${TEXT_DARK};">${date}</span>
      </div>
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">⏰ Time</span>
        <span style="font-size:15px;font-weight:700;color:${TEXT_DARK};">${time}</span>
      </div>
      ${address ? `
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">📍 Address</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${address}</span>
      </div>` : ''}
      ${projectType ? `
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">🏗️ Project Type</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${projectType}</span>
      </div>` : ''}
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">📞 Phone</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${clientPhone}</span>
      </div>
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">✉️ Email</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${clientEmail}</span>
      </div>
      ${budget ? `
      <div style="display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">💰 Budget</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${budget}</span>
      </div>` : ''}
      <div style="display:flex;align-items:flex-start;padding:10px 0;">
        <span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0;">👤 Assigned Rep</span>
        <span style="font-size:15px;font-weight:500;color:${TEXT_DARK};">${ownerName}</span>
      </div>
    </div>
    ${notesHtml}
    <div style="text-align:center;margin:32px 0 20px;">
      <a href="${CRM_PUBLIC_URL}/leads/${leadId}" style="display:inline-block;background:${NAVY};color:#fff !important;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:16px 32px;border-radius:6px;">Open Lead in CRM</a>${mapsButton}
    </div>
    <p style="font-size:13px;color:${TEXT_MUTED};line-height:1.7;margin-top:16px;text-align:center;">
      Good luck with your ${isPhoneCall ? 'call' : 'appointment'}! 🏗️
    </p>
  `);
}

// Subject generation + idempotency + activity content — mirrored from the
// Base44 handler so the parity test can compare these strings too.
function clientSubjectMeeting({ label, isCatchUp }) {
  return isCatchUp
    ? `Your Appointment is Confirmed — ${COMPANY_NAME}`
    : `Appointment Reminder in ${label} — ${COMPANY_NAME}`;
}
function clientSubjectPhoneCall({ label, isCatchUp }) {
  return isCatchUp
    ? `Your Phone Call is Confirmed — ${COMPANY_NAME}`
    : `Phone Call Reminder in ${label} — ${COMPANY_NAME}`;
}
function staffSubject({ clientName, date, time, isPhoneCall, label, isCatchUp }) {
  return isCatchUp
    ? `📅 New Appointment: ${clientName} — ${date} at ${time}`
    : `${isPhoneCall ? 'Phone Call' : 'Appointment'} in ${label}: ${clientName}`;
}
function reminderIdempotencyKey(leadId, windowKey, date) {
  return `reminder:${leadId}:${windowKey}:${date}`;
}
function reminderActivityContent(key) {
  return `REMINDER_SENT:${key}`;
}

module.exports = {
  clientMeetingEmail, clientPhoneCallEmail, repReminderEmail,
  clientSubjectMeeting, clientSubjectPhoneCall, staffSubject,
  reminderIdempotencyKey, reminderActivityContent,
  COMPANY_NAME, LOGO_URL,
};