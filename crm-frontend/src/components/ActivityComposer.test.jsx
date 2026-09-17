/**
 * ActivityComposer.test.jsx — Owner Directory / outbound-email regression
 * coverage.
 *
 * Production defect: a legitimate, active owner (Yaron Drilevich) showed
 * "Yaron Drilevich (not configured)" and blocked sending entirely. Root
 * cause: the composer resolved sender emails from a separate, hand-
 * maintained Settings blob ('owner_emails') instead of the canonical
 * `owners` table (routes/owners.js) — and even when resolved, it called
 * POST /gmail/send-email-via-account, which has always returned 501 "not
 * implemented yet" (a per-owner Gmail architecture that was never built).
 * Fixed to resolve owners from the canonical directory and send through
 * the one real, working path (POST /api/v1/emails/send, the single
 * connected company Gmail account), using the owner's address only as
 * Reply-To.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ActivityComposer from './ActivityComposer';

const listOwners = vi.fn();
const sendEmail = vi.fn();
const createActivity = vi.fn();
vi.mock('@/api/railway', () => ({
  activities: { create: (...a) => createActivity(...a) },
  leads: { getByExternal: vi.fn(), updateByExternal: vi.fn() },
  tasks: { create: vi.fn() },
  owners: { list: (...a) => listOwners(...a) },
  emails: { send: (...a) => sendEmail(...a) },
}));
// A stable object reference — useAuth()'s real implementation returns a
// stable reference from React context; recreating a new object literal on
// every call here (the naive mock) would make the component's
// useEffect([authUser]) dependency "change" on every render, looping
// forever. Define it once outside the mock factory instead.
const AUTH_USER = { full_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com' };
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: AUTH_USER }),
}));

function lead(overrides = {}) {
  return { id: 'lead-1', railway_id: 'lead-1', first_name: 'Brian', last_name: 'Krantz', email: 'brian.krantz1@gmail.com', assigned_rep: 'Yaron Drilevich', ...overrides };
}

beforeEach(() => {
  listOwners.mockReset();
  sendEmail.mockReset();
  createActivity.mockReset();
  createActivity.mockResolvedValue({ activity: { id: 'act-1' } });
});

async function openEmailTab() {
  render(<ActivityComposer lead={lead()} onActivityCreated={vi.fn()} />);
  fireEvent.click(screen.getByText('Email'));
}

describe('ActivityComposer — Owner Directory resolves from the canonical owners table', () => {
  it('a legitimate, active owner (Yaron Drilevich) resolves — no "not configured" warning', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', display_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com', is_active: true }] });
    await openEmailTab();
    await waitFor(() => expect(screen.getByText(/Replies will go to Yaron Drilevich/)).toBeInTheDocument());
    expect(screen.queryByText(/not configured/)).toBeNull();
    expect(screen.queryByText(/not found in the Owner Directory/)).toBeNull();
  });

  it('an owner missing from the directory shows a truthful, non-blocking state (not "not configured")', async () => {
    listOwners.mockResolvedValue({ items: [] });
    await openEmailTab();
    await waitFor(() => expect(screen.getByText(/not found in the Owner Directory/)).toBeInTheDocument());
  });

  it('display-name variation (extra whitespace) still resolves — presentation, not identity', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', display_name: '  Yaron Drilevich  ', email: 'yaron@ecconstructiongroup.com', is_active: true }] });
    await openEmailTab();
    await waitFor(() => expect(screen.getByText(/Replies will go to Yaron Drilevich/)).toBeInTheDocument());
  });

  it('the sender shown is always the single connected company account, never an individual owner inbox', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', display_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com', is_active: true }] });
    await openEmailTab();
    await waitFor(() => expect(screen.getByText('EC Construction Group (connected company Gmail account)')).toBeInTheDocument());
  });
});

describe('ActivityComposer — sending uses the one real, working email path', () => {
  it('sending is NOT blocked by an unresolved owner — only content/subject/lead.email are required', async () => {
    listOwners.mockResolvedValue({ items: [] }); // owner never resolves
    await openEmailTab();
    fireEvent.change(screen.getByPlaceholderText('Email subject line...'), { target: { value: 'Following up' } });
    fireEvent.change(screen.getByPlaceholderText('Email content...'), { target: { value: 'Hi Brian, following up on your estimate.' } });
    const saveButton = screen.getByText('Save Email').closest('button');
    await waitFor(() => expect(saveButton).not.toBeDisabled());
  });

  it('Save sends via POST /api/v1/emails/send (railwayEmails.send), not the dead per-owner stub, with the owner as Reply-To', async () => {
    listOwners.mockResolvedValue({ items: [{ id: 'o1', display_name: 'Yaron Drilevich', email: 'yaron@ecconstructiongroup.com', is_active: true }] });
    sendEmail.mockResolvedValue({ ok: true });
    await openEmailTab();
    await waitFor(() => expect(screen.getByText(/Replies will go to Yaron Drilevich/)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Email subject line...'), { target: { value: 'Following up' } });
    fireEvent.change(screen.getByPlaceholderText('Email content...'), { target: { value: 'Hi Brian, following up on your estimate.' } });
    fireEvent.click(screen.getByText('Save Email'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    const call = sendEmail.mock.calls[0][0];
    expect(call.to).toBe('brian.krantz1@gmail.com');
    expect(call.replyTo).toBe('yaron@ecconstructiongroup.com');
    expect(call.subject).toBe('Following up');
    expect(call.htmlBody).toContain('Hi Brian, following up on your estimate.');
  });

  it('the email body is HTML-escaped before sending (a rep typing markup cannot inject it into the outbound message)', async () => {
    listOwners.mockResolvedValue({ items: [] });
    sendEmail.mockResolvedValue({ ok: true });
    await openEmailTab();

    fireEvent.change(screen.getByPlaceholderText('Email subject line...'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByPlaceholderText('Email content...'), { target: { value: '<img src=x onerror=alert(1)>' } });
    fireEvent.click(screen.getByText('Save Email'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    const call = sendEmail.mock.calls[0][0];
    expect(call.htmlBody).not.toContain('<img');
    expect(call.htmlBody).toContain('&lt;img');
  });

  it('a lead with no email on file cannot attempt to send', async () => {
    listOwners.mockResolvedValue({ items: [] });
    render(<ActivityComposer lead={lead({ email: null })} onActivityCreated={vi.fn()} />);
    fireEvent.click(screen.getByText('Email'));
    expect(screen.getByText('No email on file for this lead')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Email subject line...'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByPlaceholderText('Email content...'), { target: { value: 'Body' } });
    const saveButton = screen.getByText('Save Email').closest('button');
    expect(saveButton).toBeDisabled();
  });
});
