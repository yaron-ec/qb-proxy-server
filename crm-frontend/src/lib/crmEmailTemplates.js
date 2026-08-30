/**
 * crmEmailTemplates — client-side HTML email templates for the Railway migration.
 *
 * Exact copies of the HTML branding used by the Base44 functions (sendManualReminder,
 * sendInvoiceEmail) so that moving the send path to Railway /internal/email/send
 * changes nothing the customer sees.
 *
 * Used by src/lib/emailTransport.js when FLOW_OWNERSHIP is 'railway'.
 */

const LOGO_URL = 'https://crm.ecconstructiongroup.com/email-logo.png';
const NAVY = '#0B2D5C';
const GOLD = '#C9A227';
const LIGHT_GRAY = '#F4F6FA';
const TEXT_DARK = '#1A1A2E';
const TEXT_MUTED = '#6B7280';

const BASE_CSS = `
  * { margin:0;padding:0;box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; background:#EEF1F7;color:${TEXT_DARK};padding:32px 16px; }
  .wrapper { max-width:650px;margin:0 auto; }
  .header { background:#fff;border-radius:12px 12px 0 0;padding:36px 48px 28px;text-align:center;border-bottom:3px solid ${GOLD}; }
  .header img { max-width:260px;height:auto;display:block;margin:0 auto; }
  .body { background:#fff;padding:40px 48px; }
  .email-title { font-size:22px;font-weight:700;color:${NAVY};margin-bottom:6px; }
  .email-subtitle { font-size:14px;color:${TEXT_MUTED};margin-bottom:28px; }
  .greeting { font-size:16px;color:${TEXT_DARK};margin-bottom:24px;line-height:1.7; }
  .detail-card { background:${LIGHT_GRAY};border-radius:10px;border-left:4px solid ${GOLD};padding:24px 28px;margin:24px 0; }
  .detail-card-title { font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:${GOLD};margin-bottom:16px; }
  .row { display:flex;align-items:flex-start;padding:10px 0;border-bottom:1px solid #DDE3EE; }
  .row:last-child { border-bottom:none; }
  .lbl { font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:${TEXT_MUTED};width:160px;flex-shrink:0; }
  .val { font-size:15px;font-weight:500;color:${TEXT_DARK};flex:1; }
  .note-box { background:#F0F4FF;border-left:4px solid #3B5FC0;border-radius:8px;padding:20px 24px;margin:24px 0; }
  .note-label { font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#3B5FC0;margin-bottom:10px; }
  .notice { background:#FFF9EC;border:1px solid #F0D98A;border-radius:8px;padding:16px 20px;margin:24px 0;font-size:14px;color:#7A5C00;line-height:1.6; }
  .cta { text-align:center;margin:32px 0; }
  .btn { display:inline-block;background:${NAVY};color:#fff !important;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:16px 32px;border-radius:6px; }
  .footer { background:${NAVY};border-radius:0 0 12px 12px;padding:28px 48px;text-align:center; }
  .footer-name { font-size:15px;font-weight:700;color:${GOLD};margin-bottom:6px; }
  .footer-sub { font-size:12px;color:rgba(255,255,255,0.65);line-height:1.8; }
  .footer-sub a { color:${GOLD};text-decoration:none; }
`;

function wrap(inner) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${BASE_CSS}</style></head><body>
  <div class="wrapper">
    <div class="header"><img src="${LOGO_URL}" alt="EC Construction Group"></div>
    <div class="body">${inner}</div>
    <div class="footer"><div class="footer-name">EC Construction Group</div><div class="footer-sub">Licensed &amp; Insured &nbsp;·&nbsp; Southern &amp; Northern California<br><a href="https://ecconstructiongroup.com">ecconstructiongroup.com</a></div></div>
  </div></body></html>`;
}

/**
 * Staff reminder HTML — exact copy of sendManualReminder's staffEmail template.
 */
export function manualStaffReminderHtml({ ownerName, clientName, clientPhone, clientEmail, date, time, address, projectType, notes, leadId, crmUrl }) {
  const mapsUrl = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
  const notesHtml = notes ? `<div class="note-box"><div class="note-label">📝 Notes</div><div style="font-size:14px;line-height:1.8;white-space:pre-wrap;">${notes}</div></div>` : '';
  const mapsBtn = mapsUrl ? `<a href="${mapsUrl}" style="display:inline-block;background:#fff;color:${NAVY} !important;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 28px;border-radius:6px;border:2px solid ${NAVY};margin-left:12px;">📍 Google Maps</a>` : '';
  const leadLink = `${crmUrl}/leads/${leadId}`;

  return wrap(`
    <div class="email-title">📅 Manual Appointment Reminder</div>
    <div class="email-subtitle">Sent manually from CRM — EC Construction Group</div>
    <div class="greeting">Hello ${ownerName},<br><br>This is a manual reminder for your upcoming appointment. Please review the details below.</div>
    <div class="detail-card">
      <div class="detail-card-title">Customer &amp; Appointment Details</div>
      <div class="row"><span class="lbl">👤 Customer</span><span class="val" style="font-weight:700;color:${NAVY}">${clientName}</span></div>
      <div class="row"><span class="lbl">📅 Date</span><span class="val">${date}</span></div>
      <div class="row"><span class="lbl">⏰ Time</span><span class="val">${time}</span></div>
      ${address ? `<div class="row"><span class="lbl">📍 Address</span><span class="val">${address}</span></div>` : ''}
      ${projectType ? `<div class="row"><span class="lbl">🏗️ Project</span><span class="val">${projectType}</span></div>` : ''}
      <div class="row"><span class="lbl">📞 Phone</span><span class="val">${clientPhone}</span></div>
      <div class="row"><span class="lbl">✉️ Email</span><span class="val">${clientEmail}</span></div>
    </div>
    ${notesHtml}
    <div class="cta">
      <a href="${leadLink}" class="btn">Open Lead in CRM</a>${mapsBtn}
    </div>
  `);
}

/**
 * Customer reminder HTML — exact copy of sendManualReminder's customerEmail template.
 */
export function manualCustomerReminderHtml({ firstName, date, time, address, projectType, ownerName }) {
  return wrap(`
    <div class="email-title">Upcoming Appointment Reminder</div>
    <div class="email-subtitle">Your appointment is coming up soon</div>
    <div class="greeting">Hi ${firstName},<br><br>This is a reminder from <strong>${ownerName}</strong> at EC Construction Group. We're looking forward to meeting with you.</div>
    <div class="detail-card">
      <div class="detail-card-title">Appointment Details</div>
      <div class="row"><span class="lbl">📅 Date</span><span class="val">${date}</span></div>
      <div class="row"><span class="lbl">⏰ Time</span><span class="val">${time}</span></div>
      ${address ? `<div class="row"><span class="lbl">📍 Address</span><span class="val">${address}</span></div>` : ''}
      ${projectType ? `<div class="row"><span class="lbl">🏗️ Project</span><span class="val">${projectType}</span></div>` : ''}
      <div class="row"><span class="lbl">👤 Rep</span><span class="val">${ownerName}</span></div>
    </div>
    <div class="notice"><strong>Important:</strong> Please ensure all decision makers are present. To reschedule, contact us at (310) 310-4108.</div>
    <div class="cta"><a href="https://ecconstructiongroup.com" class="btn">View Our Work</a></div>
    <p style="font-size:14px;color:${TEXT_MUTED};line-height:1.7;margin-top:16px;">See you soon!<br><br>Warm regards,<br><strong style="color:${NAVY}">${ownerName}</strong><br><span style="color:${TEXT_MUTED}">EC Construction Group</span></p>
  `);
}

/**
 * Invoice email HTML — functionally identical to the Base44 sendInvoiceEmail
 * plain-text body. Renders the EXACT same text the customer sees in production
 * today (no branding, no logo, no styled cards, no footer styling). Wrapped in
 * minimal HTML so /api/v1/emails/send's htmlBody field carries the same content
 * the customer received from the Base44 text/plain MIME path.
 *
 * Parity reference: base44/functions/sendInvoiceEmail/entry.ts
 *   Hello ${lead.first_name},
 *
 *   Attached is your invoice from EC Construction Group.
 *
 *   Invoice #: ${invoice.qb_invoice_number || invoice.invoice_number}
 *   Amount: $${(invoice.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
 *   Project: ${lead.project_type || 'N/A'}
 *
 *   Thank you,
 *   EC Construction Group
 */
export function invoiceEmailHtml({ firstName, invoiceNumber, amount, projectType }) {
  const num = invoiceNumber || '';
  const amt = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const project = projectType || 'N/A';
  return `<html><body>Hello ${firstName || ''},<br><br>Attached is your invoice from EC Construction Group.<br><br>Invoice #: ${num}<br>Amount: $${amt}<br>Project: ${project}<br><br>Thank you,<br>EC Construction Group</body></html>`;
}

/**
 * Simple test email HTML.
 */
export function testEmailHtml(nonce) {
  return wrap(`
    <div class="email-title">Test Email from EC Construction Group CRM</div>
    <div class="email-subtitle">Railway Email Service Test</div>
    <div class="greeting">This is a test email from the EC Construction Group CRM sent via the Railway Email Service.</div>
    <div class="detail-card">
      <div class="detail-card-title">Test Details</div>
      <div class="row"><span class="lbl">Nonce</span><span class="val" style="font-family:monospace;">${nonce || ''}</span></div>
      <div class="row"><span class="lbl">Sender</span><span class="val">yaron@ecconstructiongroup.com</span></div>
    </div>
    <p style="font-size:14px;color:${TEXT_MUTED};line-height:1.7;">No customer email was sent. This is a service verification only.</p>
  `);
}