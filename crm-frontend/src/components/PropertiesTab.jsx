import { useState, useMemo, useEffect } from "react";
import { Search, Plus, Eye, EyeOff, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from "lucide-react";
import { CATEGORIES, GROUPS, BUILT_IN_PROPERTIES } from "./properties/propertyDefinitions";
import PropertyRow from "./properties/PropertyRow";
import PropertyModal from "./properties/PropertyModal";
import PropertyDetailPanel from "./properties/PropertyDetailPanel";
import * as railwayProperties from "@/api/railway/properties";

// Storage key kept for migration only
const STORAGE_KEY = "crm_custom_properties";

function mergeProperties(builtIns, customs) {
  const overrides = {};
  customs.forEach(c => { if (c.id) overrides[c.id] = c; });
  const merged = builtIns.map(p => overrides[p.id] ? { ...p, ...overrides[p.id] } : p);
  const newCustom = customs.filter(c => !builtIns.find(b => b.id === c.id));
  return [...merged, ...newCustom];
}

const EMPTY_STATES = {
  lead_info:    { emoji: "👤", title: "No lead properties found", desc: "Try a different search or create a custom field for leads.", action: "Create Lead Property" },
  sales:        { emoji: "💰", title: "No sales properties found", desc: "Create custom fields to track deal stages, revenue, or payment details.", action: "Create Sales Property" },
  quickbooks:   { emoji: "💼", title: "No QuickBooks properties found", desc: "Connect QuickBooks or create custom sync fields for invoicing.", action: "Create QB Property" },
  integrations: { emoji: "🔗", title: "No integration properties found", desc: "Connect HubSpot, SignNow, or Google to populate integration fields here.", action: "Add Integration Field" },
  automation:   { emoji: "⚡", title: "Automation fields coming soon", desc: "Email, SMS, and pipeline automation triggers will appear here.", action: "Create Automation Field" },
  system:       { emoji: "⚙️", title: "No system fields visible", desc: "Enable 'Show hidden' to see internal timestamps and sync IDs.", action: null },
};

// Move category modal
function MoveCategoryModal({ prop, onMove, onClose }) {
  const [cat, setCat] = useState(prop?.category || "lead_info");
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-sm mx-4 p-6">
        <h3 className="text-sm font-bold text-slate-800 mb-4">Move "{prop?.label}" to Category</h3>
        <select
          value={cat}
          onChange={e => setCat(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors mb-4"
        >
          {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
        </select>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={() => onMove(prop, cat)} className="bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90">Move</button>
        </div>
      </div>
    </div>
  );
}

// System edit confirmation modal
function SystemEditConfirm({ prop, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-slate-800 mb-1">Edit System Field?</h3>
            <p className="text-xs text-slate-500">
              <strong>{prop?.label}</strong> is a system field used for internal sync operations. Modifying its metadata may affect data sync behavior. Are you sure?
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 rounded-lg hover:bg-slate-50">Cancel</button>
          <button onClick={onConfirm} className="bg-amber-500 text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-amber-600">Edit Anyway</button>
        </div>
      </div>
    </div>
  );
}

// Collapsible group component
function PropertyGroup({ group, props, onEdit, onDuplicate, onArchive, onToggleHide, onMoveCategory, onOpenDetail, customProps }) {
  const [collapsed, setCollapsed] = useState(false);
  if (props.length === 0) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 transition-colors text-left border-b border-slate-200"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
        <span className="text-xs font-semibold text-slate-500">{group.label}</span>
        <span className="text-xs text-slate-400 font-medium ml-1">({props.length})</span>
      </button>
      {!collapsed && (
        <div className="divide-y divide-slate-100">
          {props.map(prop => (
            <PropertyRow
              key={prop.id}
              prop={prop}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onArchive={onArchive}
              onToggleHide={onToggleHide}
              onMoveCategory={onMoveCategory}
              onOpenDetail={onOpenDetail}
              isCustom={!!customProps.find(c => c.id === prop.id && c.isCustom)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PropertiesTab() {
  const [customProps, setCustomProps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState("lead_info");
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [modalProp, setModalProp] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [detailProp, setDetailProp] = useState(null);
  const [moveProp, setMoveProp] = useState(null);
  const [systemConfirmProp, setSystemConfirmProp] = useState(null);

  // Load from DB on mount, migrate from localStorage if needed
  useEffect(() => {
    railwayProperties.list().then(r => r.items || []).then(dbProps => {
      if (dbProps.length > 0) {
        // DB has data — use it
        const mapped = dbProps.map(p => {
          let parsed = {};
          if (p.value) { try { parsed = JSON.parse(p.value); } catch { parsed = {}; } }
          return {
            id: p.key,
            label: parsed.label || p.key,
            ...parsed,
            _dbId: p.id,
            isCustom: true,
          };
        });
        setCustomProps(mapped);
      } else {
        // Try migrating from localStorage
        try {
          const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
          if (local.length > 0) {
            // Migrate each to DB
            Promise.all(local.map(p =>
              railwayProperties.create({ key: p.id, value: JSON.stringify(p), type: "json", description: p.label })
            )).then(created => {
              const mapped = created.map((rec, i) => ({ ...local[i], _dbId: rec.id, isCustom: true }));
              setCustomProps(mapped);
              localStorage.removeItem(STORAGE_KEY);
            });
          }
        } catch {}
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const allProperties = useMemo(() => mergeProperties(BUILT_IN_PROPERTIES, customProps), [customProps]);

  // Category counts always include hidden
  const categoryCounts = useMemo(() => {
    const counts = {};
    CATEGORIES.forEach(c => { counts[c.id] = allProperties.filter(p => p.category === c.id).length; });
    return counts;
  }, [allProperties]);

  // Filtered for current category view
  const filteredInCategory = useMemo(() => {
    return allProperties.filter(p => {
      const matchCat = search ? true : p.category === activeCategory;
      const matchSearch = !search ||
        p.label.toLowerCase().includes(search.toLowerCase()) ||
        p.description?.toLowerCase().includes(search.toLowerCase()) ||
        p.id?.toLowerCase().includes(search.toLowerCase()) ||
        CATEGORIES.find(c => c.id === p.category)?.label.toLowerCase().includes(search.toLowerCase());
      const matchHidden = showHidden || !p.hidden;
      return matchCat && matchSearch && matchHidden;
    });
  }, [allProperties, activeCategory, search, showHidden]);

  // Group the filtered props for the active category
  const groups = useMemo(() => {
    if (search) return null; // When searching, flat list across all categories
    const catGroups = GROUPS[activeCategory] || [];
    const grouped = catGroups.map(g => ({
      ...g,
      props: filteredInCategory.filter(p => g.fields.includes(p.id)),
    }));
    const assignedIds = catGroups.flatMap(g => g.fields);
    const ungrouped = filteredInCategory.filter(p => !assignedIds.includes(p.id));
    if (ungrouped.length > 0) grouped.push({ id: "other", label: "Other", props: ungrouped });
    return grouped.filter(g => g.props.length > 0);
  }, [filteredInCategory, activeCategory, search]);

  const updateCustomProps = async (updated) => {
    setCustomProps(updated);
    // Persist each new/modified custom prop to DB
    // (handled individually in handleSave/handleArchive/etc.)
  };

  const openEdit = (prop) => {
    if (prop.isSystem) { setSystemConfirmProp(prop); return; }
    setModalProp(prop); setShowModal(true);
  };
  const closeModal = () => { setShowModal(false); setModalProp(null); };

  const handleSave = async (form) => {
    const isNew = !modalProp?.id || modalProp?.id?.startsWith?.('custom_') === false && !modalProp?._dbId;
    const id = modalProp?.id || `custom_${Date.now()}`;
    const existing = customProps.find(p => p.id === id);

    if (!existing || !existing._dbId) {
      // Create new in DB
      const rec = await railwayProperties.create({
        key: id,
        value: JSON.stringify({ ...form, id, isCustom: true }),
        type: "json",
        description: form.label,
      });
      setCustomProps(prev => [...prev, { ...form, id, isCustom: true, _dbId: rec.id }]);
    } else {
      // Update existing in DB
      const updated = { ...existing, ...form };
      await railwayProperties.update(existing._dbId, {
        value: JSON.stringify(updated),
        description: form.label,
      });
      setCustomProps(prev => prev.map(p => p.id === id ? { ...updated, _dbId: existing._dbId } : p));
    }
    closeModal();
  };

  const handleDuplicate = async (prop) => {
    const newId = `custom_${Date.now()}`;
    const dup = { ...prop, id: newId, label: `${prop.label} (Copy)`, isCustom: true };
    delete dup._dbId;
    const rec = await railwayProperties.create({
      key: newId,
      value: JSON.stringify(dup),
      type: "json",
      description: dup.label,
    });
    setCustomProps(prev => [...prev, { ...dup, _dbId: rec.id }]);
  };

  const handleArchive = async (prop) => {
    if (!confirm(`Archive "${prop.label}"? It will be removed from this list.`)) return;
    if (prop._dbId) {
      await railwayProperties.remove(prop._dbId);
    }
    setCustomProps(prev => prev.filter(p => p.id !== prop.id));
  };

  const handleToggleHide = async (prop) => {
    const existing = customProps.find(p => p.id === prop.id);
    const newHidden = !prop.hidden;
    if (existing?._dbId) {
      const updated = { ...existing, hidden: newHidden };
      await railwayProperties.update(existing._dbId, { value: JSON.stringify(updated) });
      setCustomProps(prev => prev.map(p => p.id === prop.id ? updated : p));
    } else {
      // Built-in override
      const newProp = { id: prop.id, hidden: newHidden };
      const rec = await railwayProperties.create({ key: prop.id, value: JSON.stringify(newProp), type: "json", description: prop.label });
      setCustomProps(prev => [...prev, { ...newProp, _dbId: rec.id }]);
    }
  };

  const handleMoveCategory = async (prop, newCategory) => {
    const existing = customProps.find(p => p.id === prop.id);
    if (existing?._dbId) {
      const updated = { ...existing, category: newCategory };
      await railwayProperties.update(existing._dbId, { value: JSON.stringify(updated) });
      setCustomProps(prev => prev.map(p => p.id === prop.id ? updated : p));
    } else {
      const newProp = { id: prop.id, category: newCategory };
      const rec = await railwayProperties.create({ key: prop.id, value: JSON.stringify(newProp), type: "json", description: prop.label });
      setCustomProps(prev => [...prev, { ...newProp, _dbId: rec.id }]);
    }
    setMoveProp(null);
  };

  const activeCategory_obj = CATEGORIES.find(c => c.id === activeCategory);
  const emptyState = EMPTY_STATES[activeCategory];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading properties...
      </div>
    );
  }

  return (
    <div className="flex gap-0 max-w-6xl -mx-2">
      {/* LEFT NAV */}
      <aside className="w-52 flex-shrink-0 bg-white border border-slate-200 rounded-xl mr-5 overflow-hidden self-start sticky top-0">
        <div className="px-4 py-3 border-b border-slate-100">
          <p className="text-xs font-semibold text-slate-500">Categories</p>
        </div>
        <nav className="py-2">
          {CATEGORIES.map(cat => {
            const active = activeCategory === cat.id && !search;
            return (
              <button
                key={cat.id}
                onClick={() => { setActiveCategory(cat.id); setSearch(""); }}
                className={`w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors text-left relative ${active ? "bg-amber-50 text-amber-700 font-semibold" : "text-slate-600 hover:bg-slate-50 hover:text-slate-800 font-medium"}`}
              >
                {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-orange rounded-r-full" />}
                <span className="flex items-center gap-2">
                  <span>{cat.icon}</span>
                  <span className="truncate">{cat.label}</span>
                </span>
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${active ? "bg-orange text-white" : "bg-slate-100 text-slate-500"}`}>
                  {categoryCounts[cat.id] || 0}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
              {!search && <span>{activeCategory_obj?.icon}</span>}
              {search ? `Search results` : activeCategory_obj?.label}
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {filteredInCategory.length} propert{filteredInCategory.length !== 1 ? "ies" : "y"}
              {search && ` matching "${search}"`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHidden(!showHidden)}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${showHidden ? "border-orange text-orange bg-orange/5" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
            >
              {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {showHidden ? "Showing hidden" : "Show hidden"}
            </button>
            <button
              onClick={() => { setModalProp({ category: activeCategory }); setShowModal(true); }}
              className="flex items-center gap-2 bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors"
            >
              <Plus className="w-4 h-4" /> Create Property
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by label, description, internal key, or category..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full border border-slate-200 rounded-lg pl-9 pr-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-orange transition-colors bg-white"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs font-semibold">✕</button>
          )}
        </div>

        {/* System warning */}
        {activeCategory === "system" && !search && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-amber-700">
              <strong>System fields</strong> are used internally for syncing with QuickBooks, HubSpot, and Google. Do not expose raw IDs to end users or modify these manually.
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_128px_80px_80px_36px] gap-3 px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <div className="text-[11px] font-semibold text-slate-400">Property Name</div>
            <div className="text-[11px] font-semibold text-slate-400 text-right">Type</div>
            <div className="text-[11px] font-semibold text-slate-400 text-center">Access</div>
            <div className="text-[11px] font-semibold text-slate-400 text-center">Visibility</div>
            <div></div>
          </div>

          {filteredInCategory.length === 0 ? (
            <EmptyState category={activeCategory} emptyState={emptyState} search={search} onCreate={() => { setModalProp({ category: activeCategory }); setShowModal(true); }} />
          ) : search ? (
            // Flat list when searching across all categories
            <div className="divide-y divide-slate-100">
              {filteredInCategory.map(prop => (
                <PropertyRow
                  key={prop.id}
                  prop={prop}
                  onEdit={openEdit}
                  onDuplicate={handleDuplicate}
                  onArchive={handleArchive}
                  onToggleHide={handleToggleHide}
                  onMoveCategory={(p) => setMoveProp(p)}
                  onOpenDetail={setDetailProp}
                  isCustom={!!customProps.find(c => c.id === prop.id && c.isCustom)}
                />
              ))}
            </div>
          ) : (
            // Grouped view
            <div>
              {groups && groups.map(g => (
                <PropertyGroup
                  key={g.id}
                  group={g}
                  props={g.props}
                  onEdit={openEdit}
                  onDuplicate={handleDuplicate}
                  onArchive={handleArchive}
                  onToggleHide={handleToggleHide}
                  onMoveCategory={(p) => setMoveProp(p)}
                  onOpenDetail={setDetailProp}
                  customProps={customProps}
                />
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-slate-400 text-center pb-4">
          Click any property to view details. Built-in properties reflect the Lead entity schema.
        </p>
      </div>

      {/* Modals & Panels */}
      {showModal && (
        <PropertyModal property={modalProp} onSave={handleSave} onClose={closeModal} />
      )}

      {detailProp && (
        <PropertyDetailPanel
          prop={detailProp}
          onClose={() => setDetailProp(null)}
          onEdit={(p) => { setDetailProp(null); openEdit(p); }}
        />
      )}

      {moveProp && (
        <MoveCategoryModal
          prop={moveProp}
          onMove={handleMoveCategory}
          onClose={() => setMoveProp(null)}
        />
      )}

      {systemConfirmProp && (
        <SystemEditConfirm
          prop={systemConfirmProp}
          onConfirm={() => { setSystemConfirmProp(null); setModalProp(systemConfirmProp); setShowModal(true); }}
          onCancel={() => setSystemConfirmProp(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ category, emptyState, search, onCreate }) {
  return (
    <div className="py-14 text-center px-8">
      <div className="text-4xl mb-3">{emptyState?.emoji || "🔍"}</div>
      <div className="text-sm font-bold text-slate-600 mb-1">{search ? "No properties match your search" : emptyState?.title}</div>
      <div className="text-xs text-slate-400 max-w-xs mx-auto mb-4">{search ? "Try searching by label, description, key, or category name." : emptyState?.desc}</div>
      {!search && emptyState?.action && (
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-2 bg-orange text-white px-4 py-2 text-sm font-bold rounded-lg hover:bg-orange/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> {emptyState.action}
        </button>
      )}
    </div>
  );
}