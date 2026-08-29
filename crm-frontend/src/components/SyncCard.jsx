/**
 * Shared building blocks for all Sync tabs.
 * Import from here to keep every tab looking identical.
 */

// ── Section card ─────────────────────────────────────────────────────────────
export function SyncSection({ children, className = "" }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

// ── Section header row (icon + title + optional badge + optional action) ──────
export function SyncSectionHeader({ icon: Icon, title, badge, action, iconColor = "text-slate-500" }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-2.5">
        {Icon && <Icon className={`w-4 h-4 flex-shrink-0 ${iconColor}`} />}
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        {badge && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.className}`}>
            {badge.label}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────
export function StatusPill({ status }) {
  const map = {
    connected:    "bg-emerald-100 text-emerald-700",
    disconnected: "bg-slate-100 text-slate-500",
    error:        "bg-red-100 text-red-700",
    inactive:     "bg-slate-100 text-slate-500",
    active:       "bg-emerald-100 text-emerald-700",
    syncing:      "bg-blue-100 text-blue-700",
    success:      "bg-emerald-100 text-emerald-700",
    warning:      "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full ${map[status] || "bg-slate-100 text-slate-500"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ── Info notice (replaces heavy dark banners) ─────────────────────────────────
export function SyncInfoNotice({ children, variant = "neutral" }) {
  const styles = {
    neutral: "bg-slate-50 border-slate-200 text-slate-600",
    blue:    "bg-blue-50 border-blue-200 text-blue-700",
    amber:   "bg-amber-50 border-amber-200 text-amber-700",
    green:   "bg-emerald-50 border-emerald-200 text-emerald-700",
    red:     "bg-red-50 border-red-200 text-red-700",
  };
  return (
    <div className={`border rounded-lg px-4 py-3 text-xs ${styles[variant]}`}>
      {children}
    </div>
  );
}

// ── Compact stat row ──────────────────────────────────────────────────────────
export function SyncStatRow({ items }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ label, value, color = "slate" }) => {
        const colors = {
          slate:   "bg-slate-100 text-slate-700",
          blue:    "bg-blue-100 text-blue-700",
          green:   "bg-emerald-100 text-emerald-700",
          amber:   "bg-amber-100 text-amber-700",
          red:     "bg-red-100 text-red-700",
          purple:  "bg-purple-100 text-purple-700",
        };
        return (
          <div key={label} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${colors[color]}`}>
            <span className="font-bold">{value ?? 0}</span>
            <span className="text-[10px] font-medium opacity-80">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Primary button ────────────────────────────────────────────────────────────
export function SyncBtn({ onClick, disabled, loading, icon: Icon, children, variant = "primary", className = "" }) {
  const base = "inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-50";
  const variants = {
    primary:   "bg-amber-600 hover:bg-amber-700 text-white",
    secondary: "bg-white border border-slate-200 hover:bg-slate-50 text-slate-700",
    danger:    "bg-white border border-red-200 hover:bg-red-50 text-red-600",
    green:     "bg-emerald-600 hover:bg-emerald-700 text-white",
    blue:      "bg-blue-600 hover:bg-blue-700 text-white",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>
      {loading
        ? <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
        : Icon && <Icon className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

// ── Step list (replaces numbered instruction blobs) ───────────────────────────
export function SyncStepList({ steps, variant = "neutral" }) {
  const styles = {
    neutral: "border-slate-200 bg-slate-50",
    blue:    "border-blue-200 bg-blue-50",
    amber:   "border-amber-200 bg-amber-50",
  };
  const textStyles = {
    neutral: "text-slate-600",
    blue:    "text-blue-700",
    amber:   "text-amber-700",
  };
  return (
    <ol className={`border rounded-lg px-4 py-3 space-y-1.5 ${styles[variant]}`}>
      {steps.map((step, i) => (
        <li key={i} className={`flex gap-2 text-xs ${textStyles[variant]}`}>
          <span className="font-bold flex-shrink-0 opacity-60">{i + 1}.</span>
          <span dangerouslySetInnerHTML={{ __html: step }} />
        </li>
      ))}
    </ol>
  );
}

// ── Result feedback row ───────────────────────────────────────────────────────
export function SyncResult({ success, message, error }) {
  if (!message && !error) return null;
  if (success) {
    return (
      <SyncInfoNotice variant="green">
        <span className="font-semibold">✓ {message}</span>
      </SyncInfoNotice>
    );
  }
  return (
    <SyncInfoNotice variant="red">
      <span className="font-semibold">Error: {error || message}</span>
    </SyncInfoNotice>
  );
}