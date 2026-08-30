/**
 * EC Construction Group — Unified Email Design System
 * Import this into React components only (not backend functions).
 * For backend functions, copy the buildEmail helpers inline.
 */

export const EC_NAVY = '#0B2D5C';
export const EC_GOLD = '#C9A227';
export const EC_LIGHT_GRAY = '#F4F6FA';
export const EC_TEXT_DARK = '#1A1A2E';
export const EC_TEXT_MUTED = '#6B7280';
export const EC_LOGO_URL = 'https://crm.ecconstructiongroup.com/email-logo.png';

export const EMAIL_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background-color: #EEF1F7;
    color: #1A1A2E;
    padding: 32px 16px;
    -webkit-font-smoothing: antialiased;
  }
  .wrapper { max-width: 650px; margin: 0 auto; }
  .header {
    background: #ffffff;
    border-radius: 12px 12px 0 0;
    padding: 36px 48px 28px;
    text-align: center;
    border-bottom: 3px solid #C9A227;
  }
  .header img { max-width: 260px; height: auto; display: block; margin: 0 auto; }
  .body { background: #ffffff; padding: 40px 48px; }
  .email-title { font-size: 22px; font-weight: 700; color: #0B2D5C; letter-spacing: -0.3px; margin-bottom: 6px; }
  .email-subtitle { font-size: 14px; color: #6B7280; margin-bottom: 28px; }
  .greeting { font-size: 16px; color: #1A1A2E; margin-bottom: 24px; line-height: 1.7; }
  .summary-card {
    background: #F4F6FA;
    border-radius: 10px;
    border-left: 4px solid #C9A227;
    padding: 24px 28px;
    margin: 24px 0;
  }
  .summary-card-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1.5px; color: #C9A227; margin-bottom: 16px;
  }
  .summary-row { display: flex; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid #DDE3EE; }
  .summary-row:last-child { border-bottom: none; }
  .summary-label {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.8px; color: #6B7280; width: 140px; flex-shrink: 0; padding-top: 1px;
  }
  .summary-value { font-size: 15px; font-weight: 500; color: #1A1A2E; flex: 1; }
  .notice-box {
    background: #FFF9EC; border: 1px solid #F0D98A; border-radius: 8px;
    padding: 16px 20px; margin: 24px 0; font-size: 14px; color: #7A5C00; line-height: 1.6;
  }
  .notice-box strong { color: #5C4400; }
  .cta-wrapper { text-align: center; margin: 32px 0 28px; }
  .cta-button {
    display: inline-block; background: #0B2D5C; color: #ffffff !important;
    text-decoration: none; font-size: 13px; font-weight: 700;
    letter-spacing: 1.5px; text-transform: uppercase; padding: 16px 40px;
    border-radius: 6px; border: 2px solid #0B2D5C;
  }
  .contact-section { background: #F4F6FA; border-radius: 8px; padding: 20px 24px; margin-top: 28px; }
  .contact-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1.5px; color: #6B7280; margin-bottom: 12px;
  }
  .contact-row { font-size: 13px; color: #1A1A2E; line-height: 2; }
  .contact-row a { color: #0B2D5C; text-decoration: none; font-weight: 500; }
  .footer { background: #0B2D5C; border-radius: 0 0 12px 12px; padding: 28px 48px; text-align: center; }
  .footer-company { font-size: 15px; font-weight: 700; color: #C9A227; letter-spacing: 0.5px; margin-bottom: 6px; }
  .footer-tagline { font-size: 12px; color: rgba(255,255,255,0.65); line-height: 1.8; }
  .footer-tagline a { color: #C9A227; text-decoration: none; }
  @media (max-width: 600px) {
    .header, .body { padding-left: 24px !important; padding-right: 24px !important; }
    .footer { padding-left: 24px !important; padding-right: 24px !important; }
    .summary-label { width: 100px; font-size: 11px; }
    .summary-value { font-size: 14px; }
    .cta-button { padding: 14px 28px; font-size: 12px; }
  }
`;