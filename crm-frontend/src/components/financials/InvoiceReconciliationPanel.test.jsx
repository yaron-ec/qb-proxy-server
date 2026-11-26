/**
 * InvoiceReconciliationPanel.test.jsx — admin-only, read-only "Invoice
 * Reconciliation" button/modal built on the existing PR #84 backend
 * endpoint (November 2026, Lalani $1,097 discrepancy investigation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import InvoiceReconciliationPanel from "./InvoiceReconciliationPanel";

const getInvoiceReconciliation = vi.fn();
vi.mock("@/api/railway/deals", () => ({
  getInvoiceReconciliation: (...a) => getInvoiceReconciliation(...a),
}));

function reconciliationResponse(overrides = {}) {
  return {
    found: true,
    root_deal: { id: "root-1", name: "Lalani Roof Replacement", amount: 33000 },
    addendum_deals: [{ id: "addendum-1", name: "Lalani Bathroom Repair", amount: 7934 }],
    qb_customer_id: "123",
    invoices: [
      {
        qb_invoice_id: "1001",
        qb_doc_number: "HNDF-INV-1",
        invoice_date: "2026-08-01",
        original_amount: 33000,
        paid_amount: 33000,
        outstanding_balance: 0,
        txn_status: "Paid",
        cache_voided: false,
        mapping_voided: false,
        mapping_method: "direct",
        associated_project: "Lalani Roof Replacement (root)",
        last_synchronized_at: "2026-11-01T12:00:00Z",
        included_in_collected_calculation: true,
        amount_included_in_collected: 33000,
        duplicate_document_number: false,
      },
      {
        qb_invoice_id: "1002",
        qb_doc_number: "HNDF-INV-2",
        invoice_date: "2026-08-15",
        original_amount: 1097,
        paid_amount: 1097,
        outstanding_balance: 0,
        txn_status: "Paid",
        cache_voided: true,
        mapping_voided: false,
        mapping_method: "direct",
        associated_project: "Lalani Roof Replacement (root)",
        last_synchronized_at: "2026-11-01T12:00:00Z",
        included_in_collected_calculation: false,
        amount_included_in_collected: 0,
        duplicate_document_number: false,
      },
    ],
    summary: {
      computed_invoiced_total: 33000,
      computed_collected_total: 33000,
      customer_total_received_all_cached_invoices: 34097,
      unclaimed_remainder_for_fallback_or_excess: 1097,
      duplicate_document_numbers_found: [],
      invoices_mapped_to_a_different_deal: 0,
      invoices_not_mapped_to_any_deal: 0,
      voided_invoices_excluded_from_totals: 1,
    },
    ...overrides,
  };
}

beforeEach(() => {
  getInvoiceReconciliation.mockReset();
});

describe("InvoiceReconciliationPanel", () => {
  it("does not call the endpoint on mount — only when the button is clicked", () => {
    render(<InvoiceReconciliationPanel dealId="root-1" />);
    expect(getInvoiceReconciliation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("invoice-reconciliation-content")).not.toBeInTheDocument();
  });

  it("fetches with the deal id and renders the itemized table, summary, and warnings on click", async () => {
    getInvoiceReconciliation.mockResolvedValue(reconciliationResponse());
    render(<InvoiceReconciliationPanel dealId="root-1" />);

    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));

    await waitFor(() => expect(getInvoiceReconciliation).toHaveBeenCalledWith("root-1"));
    await waitFor(() => expect(screen.getByTestId("invoice-reconciliation-content")).toBeInTheDocument());

    const rows = screen.getAllByTestId("invoice-reconciliation-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("HNDF-INV-1")).toBeInTheDocument();
    expect(screen.getByText("HNDF-INV-2")).toBeInTheDocument();
    // Voided invoice is shown (never hidden) but flagged, and never counted.
    expect(screen.getByText("Voided (cache)")).toBeInTheDocument();
    // Computed totals are shown, clearly distinguished from a live check.
    expect(screen.getByText(/cached data from/i)).toBeInTheDocument();
    expect(screen.getByText(/\$1,097\.00 of this customer's total cached payments is not/)).toBeInTheDocument();
  });

  it("surfaces the specific backend error message rather than a generic failure", async () => {
    getInvoiceReconciliation.mockRejectedValue(
      Object.assign(new Error("fetch failed"), { data: { message: "invoice_reconciliation_failed: db unavailable" } })
    );
    render(<InvoiceReconciliationPanel dealId="root-1" />);
    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));
    await waitFor(() => expect(screen.getByText(/db unavailable/)).toBeInTheDocument());
  });

  it("shows duplicate-document-number and wrong-project warnings distinctly", async () => {
    getInvoiceReconciliation.mockResolvedValue(
      reconciliationResponse({
        invoices: [
          {
            qb_invoice_id: "2001",
            qb_doc_number: "DUP-1",
            invoice_date: "2026-09-01",
            original_amount: 500,
            paid_amount: 500,
            outstanding_balance: 0,
            txn_status: "Paid",
            cache_voided: false,
            mapping_voided: false,
            mapping_method: "direct",
            associated_project: "A DIFFERENT, unrelated deal: Some Other Project (other-deal-id)",
            last_synchronized_at: "2026-11-01T12:00:00Z",
            included_in_collected_calculation: false,
            amount_included_in_collected: 0,
            duplicate_document_number: true,
          },
        ],
        summary: {
          computed_invoiced_total: 0,
          computed_collected_total: 0,
          customer_total_received_all_cached_invoices: 500,
          unclaimed_remainder_for_fallback_or_excess: 500,
          duplicate_document_numbers_found: ["DUP-1"],
          invoices_mapped_to_a_different_deal: 1,
          invoices_not_mapped_to_any_deal: 0,
          voided_invoices_excluded_from_totals: 0,
        },
      })
    );
    render(<InvoiceReconciliationPanel dealId="root-1" />);
    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));
    await waitFor(() => expect(screen.getByTestId("invoice-reconciliation-content")).toBeInTheDocument());
    expect(screen.getByText("Duplicate doc #")).toBeInTheDocument();
    expect(screen.getByText("Wrong project")).toBeInTheDocument();
    expect(screen.getByText(/1 duplicate document number\(s\): DUP-1/)).toBeInTheDocument();
    expect(screen.getByText(/1 invoice\(s\) mapped to a different, unrelated deal/)).toBeInTheDocument();
  });

  it("shows the no-QuickBooks-customer note instead of a table when the project has no linked customer", async () => {
    getInvoiceReconciliation.mockResolvedValue({
      found: true,
      root_deal: { id: "root-1", name: "X", amount: 0 },
      addendum_deals: [],
      qb_customer_id: null,
      note: "This lead has no qb_customer_id — there is no QuickBooks customer to reconcile invoices against.",
      invoices: [],
      summary: null,
    });
    render(<InvoiceReconciliationPanel dealId="root-1" />);
    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));
    await waitFor(() => expect(screen.getByText(/no qb_customer_id/)).toBeInTheDocument());
    expect(screen.queryByTestId("invoice-reconciliation-content")).not.toBeInTheDocument();
  });

  it("closing and reopening without a new click does not re-fetch", async () => {
    getInvoiceReconciliation.mockResolvedValue(reconciliationResponse());
    render(<InvoiceReconciliationPanel dealId="root-1" />);
    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));
    await waitFor(() => expect(screen.getByTestId("invoice-reconciliation-content")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("invoice-reconciliation-modal-backdrop"));
    expect(screen.queryByTestId("invoice-reconciliation-content")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("invoice-reconciliation-button"));
    await waitFor(() => expect(screen.getByTestId("invoice-reconciliation-content")).toBeInTheDocument());
    expect(getInvoiceReconciliation).toHaveBeenCalledTimes(2);
  });
});
