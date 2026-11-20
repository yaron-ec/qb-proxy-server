import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import InvoiceMappingPanel from './InvoiceMappingPanel';

vi.mock('@/api/railway/qbInvoiceMapping', () => ({
  getByLead: vi.fn(),
  reassign: vi.fn(),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import * as railwayInvoiceMapping from '@/api/railway/qbInvoiceMapping';

describe('InvoiceMappingPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders nothing when the lead has fewer than 2 deals (nothing ambiguous to review)', async () => {
    railwayInvoiceMapping.getByLead.mockResolvedValue({
      lead: { id: 'l1', name: 'Solo Customer' },
      deals: [{ id: 'd1', name: 'Only Deal' }],
      invoices: [{ qb_invoice_id: 'inv1', crm_sale_id: 'd1', total_amt: 1000 }],
    });
    const { container } = render(<InvoiceMappingPanel lead={{ id: 'l1' }} canEdit={true} />);
    await waitFor(() => expect(railwayInvoiceMapping.getByLead).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders the invoice/deal picture when the lead has 2+ deals and invoices', async () => {
    railwayInvoiceMapping.getByLead.mockResolvedValue({
      lead: { id: 'l1', name: 'Ali Lalani' },
      deals: [{ id: 'roof', name: 'Roof Job' }, { id: 'bath', name: 'Bathroom Repair' }],
      invoices: [{ qb_invoice_id: 'inv1', qb_doc_number: 'HNDF-9', crm_sale_id: 'roof', total_amt: 9994, txn_date: '2026-09-01' }],
    });
    render(<InvoiceMappingPanel lead={{ id: 'l1' }} canEdit={true} />);
    await waitFor(() => expect(screen.getByText('Invoice → Project Mapping')).toBeTruthy());
    expect(screen.getByText(/currently: Roof Job/)).toBeTruthy();
    expect(screen.getByText('HNDF-9')).toBeTruthy();
  });

  it('hides the reassign controls when canEdit is false', async () => {
    railwayInvoiceMapping.getByLead.mockResolvedValue({
      lead: { id: 'l1', name: 'Ali Lalani' },
      deals: [{ id: 'roof', name: 'Roof Job' }, { id: 'bath', name: 'Bathroom Repair' }],
      invoices: [{ qb_invoice_id: 'inv1', qb_doc_number: 'HNDF-9', crm_sale_id: 'roof', total_amt: 9994 }],
    });
    render(<InvoiceMappingPanel lead={{ id: 'l1' }} canEdit={false} />);
    await waitFor(() => expect(screen.getByText('Invoice → Project Mapping')).toBeTruthy());
    expect(screen.queryByText('Reassign')).toBeNull();
  });
});
