/**
 * ActivityTab.test.jsx — verifies the "Activity feed coming soon" placeholder
 * is gone and replaced with a real, rendered project-history timeline built
 * from GET /api/v1/deals/:id/timeline events (lib/dealTimeline.js on the
 * backend). Mocks the railway API client only — everything else is a real
 * render, matching this repo's established component-test convention (see
 * ProfitabilitySummary.test.jsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { Calendar } from 'lucide-react';
import ActivityTab from './ActivityTab';
import { EditableInfoRow } from './EditableFields';

const getTimeline = vi.fn();
const uploadCompletionForm = vi.fn();
vi.mock('@/api/railway/dealTimeline', () => ({
  getTimeline: (...args) => getTimeline(...args),
  uploadCompletionForm: (...args) => uploadCompletionForm(...args),
}));

const uploadFileToStorage = vi.fn();
vi.mock('@/lib/fileUpload', () => ({
  uploadFileToStorage: (...args) => uploadFileToStorage(...args),
}));

const deal = { id: 'deal-1', lead_id: 'lead-1' };

function evt(overrides = {}) {
  return {
    id: 'evt-1', category: 'milestone', title: 'Deal Sold', date: '2026-01-05T00:00:00.000Z',
    by: 'Yaron Drilevich', amount: 45000, detail: null, document: null,
    ...overrides,
  };
}

beforeEach(() => {
  getTimeline.mockReset();
  uploadCompletionForm.mockReset();
  uploadFileToStorage.mockReset();
});

describe('ActivityTab — real project timeline, not the old placeholder', () => {
  it('never renders the old "Activity feed coming soon" placeholder text', async () => {
    getTimeline.mockResolvedValue({ events: [evt()] });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByText(/Call logs, emails, notes/i)).toBeNull();
  });

  it('renders a chronological project history for a historical deal with multiple milestones', async () => {
    getTimeline.mockResolvedValue({
      events: [
        evt({ id: 'e1', category: 'completion', title: 'Project Completed', date: '2026-06-01', amount: null }),
        evt({ id: 'e2', category: 'payment', title: 'Final Payment Paid', date: '2026-05-01', amount: 10000 }),
        evt({ id: 'e3', category: 'contract', title: 'Contract Signed', date: '2026-01-10', amount: null }),
        evt({ id: 'e4', category: 'milestone', title: 'Deal Sold', date: '2026-01-05', amount: 45000 }),
      ],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Project Completed')).toBeInTheDocument());
    expect(screen.getByText('Final Payment Paid')).toBeInTheDocument();
    expect(screen.getByText('Contract Signed')).toBeInTheDocument();
    expect(screen.getByText('Deal Sold')).toBeInTheDocument();
    expect(screen.getByText('$45,000')).toBeInTheDocument();
  });

  it('a brand-new deal with only "Deal Sold" renders exactly one event', async () => {
    getTimeline.mockResolvedValue({ events: [evt()] });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());
    expect(screen.getAllByText(/Deal Sold|Contract Signed|Payment|Completed/).length).toBe(1);
  });

  it('shows an empty state, not a crash, when there is no history yet', async () => {
    getTimeline.mockResolvedValue({ events: [] });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText(/No project history yet/i)).toBeInTheDocument());
  });

  it('shows a permission-specific message on a 403 (does not claim "not found")', async () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    getTimeline.mockRejectedValue(err);
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText(/do not have permission/i)).toBeInTheDocument());
  });

  it('a completion-form document event shows Open and Download actions', async () => {
    getTimeline.mockResolvedValue({
      events: [evt({
        id: 'e-doc', category: 'document', title: 'Completion Form Uploaded', amount: null,
        document: { url: 'https://cdn.example.com/completion.pdf', fileName: 'completion.pdf', fileType: 'application/pdf' },
      })],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Completion Form Uploaded')).toBeInTheDocument());
    expect(screen.getByText('completion.pdf')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('an image completion form renders a thumbnail, not a PDF preview toggle', async () => {
    getTimeline.mockResolvedValue({
      events: [evt({
        id: 'e-img', category: 'document', title: 'Completion Form Uploaded', amount: null,
        document: { url: 'https://cdn.example.com/completion.jpg', fileName: 'completion.jpg', fileType: 'image/jpeg' },
      })],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Completion Form Uploaded')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'completion.jpg' })).toBeInTheDocument();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('clicking Preview on a PDF completion form toggles an inline preview', async () => {
    getTimeline.mockResolvedValue({
      events: [evt({
        id: 'e-doc', category: 'document', title: 'Completion Form Uploaded', amount: null,
        document: { url: 'https://cdn.example.com/completion.pdf', fileName: 'completion.pdf', fileType: 'application/pdf' },
      })],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Preview')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByTitle('completion.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByTitle('completion.pdf')).toBeNull();
  });

  it('filters to Documents-only when the Documents chip is clicked', async () => {
    getTimeline.mockResolvedValue({
      events: [
        evt({ id: 'e1', category: 'milestone', title: 'Deal Sold' }),
        evt({ id: 'e2', category: 'document', title: 'Completion Form Uploaded', amount: null }),
      ],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Documents'));
    expect(screen.queryByText('Deal Sold')).toBeNull();
    expect(screen.getByText('Completion Form Uploaded')).toBeInTheDocument();
  });

  it('uploading a completion form uploads to storage, then registers it and reloads the timeline', async () => {
    getTimeline.mockResolvedValueOnce({ events: [evt()] });
    uploadFileToStorage.mockResolvedValue({ url: 'https://cdn.example.com/x.pdf', key: 'uploads/x.pdf', fileName: 'x.pdf', contentType: 'application/pdf', size: 1234 });
    uploadCompletionForm.mockResolvedValue({ id: 'att-1' });
    getTimeline.mockResolvedValueOnce({
      events: [evt(), evt({ id: 'e-doc', category: 'document', title: 'Completion Form Uploaded', amount: null, document: { url: 'https://cdn.example.com/x.pdf', fileName: 'x.pdf', fileType: 'application/pdf' } })],
    });

    const { container } = render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());

    const file = new File(['dummy'], 'x.pdf', { type: 'application/pdf' });
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadFileToStorage).toHaveBeenCalledWith(file));
    await waitFor(() => expect(uploadCompletionForm).toHaveBeenCalledWith('deal-1', expect.objectContaining({ fileName: 'x.pdf' })));
    await waitFor(() => expect(screen.getByText('Completion Form Uploaded')).toBeInTheDocument());
    expect(getTimeline).toHaveBeenCalledTimes(2);
  });

  it('a failed upload shows an inline error and does not crash', async () => {
    getTimeline.mockResolvedValue({ events: [evt()] });
    uploadFileToStorage.mockRejectedValue(new Error('Upload failed'));

    const { container } = render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());

    const file = new File(['dummy'], 'bad.pdf', { type: 'application/pdf' });
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Upload failed')).toBeInTheDocument());
    expect(uploadCompletionForm).not.toHaveBeenCalled();
  });

  it('a server-side rejected file type (e.g. an unsupported MIME type) surfaces the backend\'s friendly message, not a raw error code', async () => {
    getTimeline.mockResolvedValue({ events: [evt()] });
    uploadFileToStorage.mockResolvedValue({ url: 'https://cdn.example.com/x.exe', key: 'uploads/x.exe', fileName: 'x.exe', contentType: 'application/x-msdownload', size: 100 });
    uploadCompletionForm.mockRejectedValue(Object.assign(new Error('Completion Form must be a PDF, JPG, JPEG, or PNG file.'), { status: 400 }));

    const { container } = render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());

    const file = new File(['dummy'], 'x.exe', { type: 'application/x-msdownload' });
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('Completion Form must be a PDF, JPG, JPEG, or PNG file.')).toBeInTheDocument());
  });
});

describe('ActivityTab — dateKind-aware date rendering (regression: Deal Overview vs Activity date mismatch)', () => {
  it('a dateKind "date" event (a business date, e.g. Deal Sold) renders with NO timezone conversion', async () => {
    getTimeline.mockResolvedValue({
      events: [evt({ date: '2026-08-23T00:00:00.000Z', dateKind: 'date' })],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Deal Sold')).toBeInTheDocument());
    expect(screen.getByText('Aug 23, 2026')).toBeInTheDocument();
  });

  it('a dateKind "instant" event (e.g. Contract Signed) is converted to the Pacific business timezone', async () => {
    getTimeline.mockResolvedValue({
      events: [evt({
        id: 'e-contract', category: 'contract', title: 'Contract Signed', amount: null,
        date: '2026-08-23T02:00:00.000Z', dateKind: 'instant',
      })],
    });
    render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(screen.getByText('Contract Signed')).toBeInTheDocument());
    // 2026-08-23T02:00:00Z is 2026-08-22 19:00 PDT — correctly shown as Aug 22.
    expect(screen.getByText('Aug 22, 2026')).toBeInTheDocument();
  });

  it('REGRESSION: Deal Overview\'s Sold Date and Activity\'s Deal Sold date render IDENTICAL text for the same underlying deals.sold_date value', async () => {
    const soldDateIso = '2026-08-23T00:00:00.000Z';

    // Deal Overview's own rendering path (components/dealdetail/OverviewTab.jsx
    // via EditableInfoRow, type="date") — unchanged by this fix.
    const overview = render(
      <EditableInfoRow icon={Calendar} label="Sold Date" value={soldDateIso} type="date" onSave={() => {}} />
    );
    const overviewText = within(overview.container).getByText(/\w+ \d{1,2}, \d{4}/).textContent;

    // Activity's rendering path, in its own separate container — the backend
    // tags this event dateKind: 'date' for a real sold_date value (see
    // lib/dealTimeline.js).
    getTimeline.mockResolvedValue({
      events: [evt({ date: soldDateIso, dateKind: 'date' })],
    });
    const activity = render(<ActivityTab deal={deal} />);
    await waitFor(() => expect(within(activity.container).getByText('Deal Sold')).toBeInTheDocument());
    const activityText = within(activity.container).getByText(/\w+ \d{1,2}, \d{4}/).textContent;

    expect(overviewText).toBe('Aug 23, 2026');
    expect(activityText).toBe('Aug 23, 2026');
    expect(activityText).toBe(overviewText);
  });
});
