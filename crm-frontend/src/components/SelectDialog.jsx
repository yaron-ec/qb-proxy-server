import { useState } from 'react';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Search, ChevronDown } from 'lucide-react';

/**
 * SelectDialog - Mobile-friendly select replacement using Dialog
 * Props: value, onChange, options (array of {value, label}), placeholder, disabled
 */
export default function SelectDialog({ value, onChange, options, placeholder = 'Select...', disabled, className = '', compact = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selected = options.find(opt => opt.value === value);
  const filtered = options.filter(opt =>
    opt.label.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (v) => {
    onChange(v);
    setOpen(false);
    setSearch('');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          disabled={disabled}
          className={`border rounded-lg text-left text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-colors border-slate-200 flex items-center justify-between gap-1 ${
            compact ? 'px-2.5 py-1.5 text-xs btn-compact' : 'w-full px-3 py-2.5 text-sm'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-slate-300'} ${className}`}
        >
          <span className={`${selected && selected.value ? 'text-slate-900 font-semibold' : 'text-slate-400'} ${compact ? 'text-xs' : ''}`}>
            {selected?.value ? selected.label : placeholder}
          </span>
          <ChevronDown className={`text-slate-400 flex-shrink-0 ${compact ? 'w-3 h-3' : 'w-4 h-4'}`} />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm max-h-[60vh] p-0 gap-0">
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              autoFocus
              type="text"
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
        </div>
        <div className="overflow-y-auto max-h-[calc(60vh-60px)]">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-sm text-slate-400">No results</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleSelect(opt.value)}
                  className={`w-full text-left px-4 py-3 text-sm font-medium transition-colors ${
                    opt.value === value
                      ? 'bg-amber-50 text-amber-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}