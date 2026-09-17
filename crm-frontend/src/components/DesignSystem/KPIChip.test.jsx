/**
 * KPIChip.test.jsx — regression coverage for the Financials visual redesign:
 * chips no longer carry a bright per-variant colored background/border
 * (bg-amber-50/bg-emerald-50/bg-blue-50/bg-purple-50) that read as "several
 * unrelated colored boxes" — the card stays neutral white/bordered and only
 * the value text carries restrained semantic color. A zero value is
 * de-emphasized rather than colored as if it were meaningful.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KPIChip, EditableKPIChip } from './KPIChip';

describe('KPIChip — restrained neutral card, semantic color only in the value text', () => {
  it('renders a neutral white/bordered card regardless of variant', () => {
    const { container } = render(<KPIChip label="Invoiced" value={20000} variant="invoiced" />);
    const card = container.firstChild;
    expect(card).toHaveClass('bg-white');
    expect(card).toHaveClass('border-slate-200');
    expect(card.className).not.toMatch(/bg-(purple|blue|amber|emerald)-50/);
  });

  it('a positive "collected" value is colored emerald in the text only', () => {
    render(<KPIChip label="Paid" value={10000} variant="collected" />);
    expect(screen.getByText('$10,000')).toHaveClass('text-emerald-700');
  });

  it('a positive "balance" value is colored amber in the text only', () => {
    render(<KPIChip label="Balance" value={10000} variant="balance" />);
    expect(screen.getByText('$10,000')).toHaveClass('text-amber-700');
  });

  it('a zero value is de-emphasized (neutral muted text), not colored as if meaningful', () => {
    render(<KPIChip label="Paid" value={0} variant="collected" />);
    expect(screen.getByText('$0')).toHaveClass('text-slate-300');
  });

  it('EditableKPIChip enters edit mode and saves a new value', () => {
    const onSave = vi.fn();
    render(<EditableKPIChip label="Project Value" value={50000} onSave={onSave} />);
    fireEvent.click(screen.getByText('$50,000'));
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '60000' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('60000');
  });
});
