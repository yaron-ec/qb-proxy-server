import { useState } from "react";
import { Pencil, MoreVertical, Copy, Archive, EyeOff, FolderInput, Lock, Unlock, Eye, RefreshCw, AlertTriangle } from "lucide-react";
import { PROPERTY_TYPES, CATEGORIES } from "./propertyDefinitions";

const TYPE_COLORS = {
  text:         "bg-slate-100 text-slate-600",
  number:       "bg-blue-100 text-blue-700",
  currency:     "bg-emerald-100 text-emerald-700",
  date:         "bg-purple-100 text-purple-700",
  dropdown:     "bg-amber-100 text-amber-700",
  multi_select: "bg-orange/10 text-orange",
  boolean:      "bg-pink-100 text-pink-700",
  user:         "bg-cyan-100 text-cyan-700",
};

export default function PropertyRow({ prop, onEdit, onDuplicate, onArchive, onToggleHide, onMoveCategory, onOpenDetail, isCustom }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const typeLabel = PROPERTY_TYPES.find(t => t.value === prop.type)?.label || prop.type;

  const handleMenuAction = (action) => {
    setMenuOpen(false);
    action();
  };

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 hover:bg-slate-50/70 transition-colors group cursor-pointer ${prop.hidden ? 'opacity-60' : ''}`}
      onClick={() => onOpenDetail(prop)}
    >
      {/* Label + description + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-800">{prop.label}</span>
          {/* Badges */}
          {prop.required && <Badge color="red" label="Required" />}
          {prop.hidden && <Badge color="slate" label="Hidden" />}
          {!prop.editable && <Badge color="slate" label="Read-only" icon={<Lock className="w-2.5 h-2.5" />} />}
          {prop.synced && <Badge color="blue" label="Synced" icon={<RefreshCw className="w-2.5 h-2.5" />} />}
          {prop.isSystem && <Badge color="amber" label="System" icon={<AlertTriangle className="w-2.5 h-2.5" />} />}
          {isCustom && <Badge color="orange" label="Custom" />}
        </div>
        {prop.description && (
          <p className="text-xs text-slate-400 mt-0.5 truncate max-w-sm">{prop.description}</p>
        )}
      </div>

      {/* Type badge */}
      <div className="flex-shrink-0 w-28 text-right">
        <span className={`inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full ${TYPE_COLORS[prop.type] || TYPE_COLORS.text}`}>
          {typeLabel}
        </span>
      </div>

      {/* Editable */}
      <div className="flex-shrink-0 w-20 flex justify-center">
        {prop.editable ? (
          <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium"><Unlock className="w-3 h-3" />Editable</span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-slate-400 font-medium"><Lock className="w-3 h-3" />Read-only</span>
        )}
      </div>

      {/* Visibility */}
      <div className="flex-shrink-0 w-20 flex justify-center">
        {prop.hidden ? (
          <span className="flex items-center gap-1 text-xs text-slate-400 font-medium"><EyeOff className="w-3 h-3" />Hidden</span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-slate-500 font-medium"><Eye className="w-3 h-3" />Visible</span>
        )}
      </div>

      {/* 3-dot actions menu */}
      <div className="flex-shrink-0 relative" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors opacity-0 group-hover:opacity-100"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-8 bg-white border border-slate-200 rounded-xl shadow-xl z-20 py-1.5 min-w-44">
              <MenuItem icon={<Pencil className="w-3.5 h-3.5" />} label="Edit" onClick={() => handleMenuAction(() => onEdit(prop))} />
              <MenuItem icon={<Copy className="w-3.5 h-3.5" />} label="Duplicate" onClick={() => handleMenuAction(() => onDuplicate(prop))} />
              <MenuItem
                icon={<EyeOff className="w-3.5 h-3.5" />}
                label={prop.hidden ? "Make Visible" : "Hide"}
                onClick={() => handleMenuAction(() => onToggleHide(prop))}
              />
              {!prop.isSystem && (
                <MenuItem icon={<FolderInput className="w-3.5 h-3.5" />} label="Move Category" onClick={() => handleMenuAction(() => onMoveCategory(prop))} />
              )}
              {!prop.isSystem && (
                <>
                  <div className="border-t border-slate-100 my-1" />
                  <MenuItem icon={<Archive className="w-3.5 h-3.5" />} label="Archive" onClick={() => handleMenuAction(() => onArchive(prop))} color="text-red-500" />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ color, label, icon }) {
  const colors = {
    red:    "bg-red-50 text-red-600 border-red-100",
    slate:  "bg-slate-100 text-slate-500 border-slate-200",
    blue:   "bg-blue-50 text-blue-600 border-blue-100",
    amber:  "bg-amber-50 text-amber-600 border-amber-100",
    orange: "bg-orange/10 text-orange border-orange/20",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${colors[color]}`}>
      {icon}{label}
    </span>
  );
}

function MenuItem({ icon, label, onClick, color = "text-slate-700" }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-4 py-2 text-xs font-semibold hover:bg-slate-50 transition-colors ${color}`}
    >
      {icon}{label}
    </button>
  );
}