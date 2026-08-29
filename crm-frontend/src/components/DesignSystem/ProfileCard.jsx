/**
 * Unified Profile Card Component
 * For user profiles, contacts, team members
 */

import { Card, CardHeader, CardContent } from "./Card";

export function ProfileCard({ name, subtitle, avatar, children }) {
  return (
    <Card>
      <CardHeader className="flex items-center gap-3 mb-3">
        {avatar && (
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
            {avatar}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 truncate">{name}</h3>
          {subtitle && <p className="text-xs text-slate-400 truncate">{subtitle}</p>}
        </div>
      </CardHeader>
      {children && <CardContent>{children}</CardContent>}
    </Card>
  );
}

export function ProfileRow({ icon: Icon, label, value, editable = false, onEdit = null }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      {Icon && <Icon className="w-3.5 h-3.5 text-slate-300 flex-shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</p>
        <p className="text-xs text-slate-800 font-medium break-words">{value || <span className="text-slate-400">—</span>}</p>
      </div>
      {editable && onEdit && (
        <button onClick={onEdit} className="text-slate-400 hover:text-amber-600 transition-colors text-xs font-semibold">
          Edit
        </button>
      )}
    </div>
  );
}