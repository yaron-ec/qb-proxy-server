/**
 * RightSidebarAccordion
 * Accordion wrapper for the right sidebar panels.
 * Only one section open at a time.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";

function AccordionSection({ id, title, icon: SectionIcon, badge, openId, setOpenId, children }) {
  const isOpen = openId === id;
  return (
    <div className={`border-b border-slate-100 last:border-b-0 ${isOpen ? "bg-white" : ""}`}>
      <button
        onClick={() => setOpenId(isOpen ? null : id)}
        className="w-full flex items-center justify-between px-4 py-4 text-left hover:bg-slate-50 transition-colors btn-compact"
      >
        <div className="flex items-center gap-3">
          {SectionIcon && <SectionIcon className="w-5 h-5 text-slate-600 flex-shrink-0" />}
          <span className="text-sm font-bold text-slate-900">{title}</span>
          {badge != null && badge > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-amber-600 text-white text-[10px] font-bold">
              {badge}
            </span>
          )}
        </div>
        <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && (
        <div className="border-t border-slate-100">
          {children}
        </div>
      )}
    </div>
  );
}

export default function RightSidebarAccordion({ sections, defaultOpen = null }) {
  const [openId, setOpenId] = useState(defaultOpen);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {sections.map((section) => (
        <AccordionSection
          key={section.id}
          id={section.id}
          title={section.title}
          icon={section.icon}
          badge={section.badge}
          openId={openId}
          setOpenId={setOpenId}
        >
          {section.content}
        </AccordionSection>
      ))}
    </div>
  );
}