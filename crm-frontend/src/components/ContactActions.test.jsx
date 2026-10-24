/**
 * ContactActions.test.jsx — the device-native "Text" link (sms:) must be
 * clearly distinguished from the CRM's own Twilio-backed "Text Message" tab
 * (Lead Detail's activity composer) — a message sent via this button is
 * never logged, consent-checked, or visible in the CRM's SMS history. Part
 * of "CRM Lead Detail: Integrate SMS into the Main Activity and
 * Communication System" (October 2026), item 13.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ContactActions from './ContactActions';

describe('ContactActions — SMS/Text button disambiguation', () => {
  it('the device-native sms: link title explains it is NOT the CRM-tracked SMS feature', () => {
    render(<ContactActions phone="3105551234" />);
    const link = screen.getByTitle(/not tracked in the CRM/i);
    expect(link).toHaveAttribute('href', 'sms:+13105551234');
    expect(link.getAttribute('title')).toMatch(/Text Message tab/i);
  });
});
