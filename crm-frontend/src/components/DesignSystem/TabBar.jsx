/**
 * TabBar — horizontal tab navigation for detail pages.
 * Responsive: scrolls horizontally on narrow screens.
 */
export function TabBar({ tabs, activeTab, onChange, className = "" }) {
  return (
    <div className={`flex items-center gap-0.5 md:gap-1 border-b border-slate-200 overflow-x-auto bg-white ${className}`} style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-1.5 px-3 py-2.5 md:px-4 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap flex-shrink-0 ${
            activeTab === tab.id
              ? "border-amber-600 text-amber-700"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
        >
          {tab.icon && <tab.icon className="w-3.5 h-3.5" />}
          {tab.label}
          {tab.count != null && tab.count > 0 && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              activeTab === tab.id ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
            }`}>
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}