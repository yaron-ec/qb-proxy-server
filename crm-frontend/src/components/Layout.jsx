import { Outlet, Link, useLocation } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import React from "react";
import {
  LayoutDashboard, Users, BarChart2,
  Settings, ChevronLeft, ChevronRight, LogOut, TrendingUp, Map, FileBarChart, Kanban
} from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { useIsMobile } from "@/hooks/use-mobile";
import Tip from "@/components/ui/Tip";
import { companySettings as railwayCompanySettings } from "@/api/railway";

const NAV_ITEMS_ALL = [
  { path: "/",              label: "Dashboard",     icon: BarChart2 },
  { path: "/leads",         label: "Active Leads",  icon: Users },
  { path: "/kanban",        label: "Status Board",  icon: Kanban },
  { path: "/daily-map",     label: "Appointment Map", icon: Map },
  { path: "/deals",         label: "Deals",         icon: TrendingUp },
  { path: "/reports",       label: "Reports",       icon: FileBarChart },
  { path: "/settings",      label: "Settings",      icon: Settings },
];

const NAV_ITEMS_SALES_REP = [
  { path: "/",              label: "Dashboard",     icon: BarChart2 },
  { path: "/leads",         label: "Active Leads",  icon: Users },
  { path: "/kanban",        label: "Status Board",  icon: Kanban },
  { path: "/daily-map",     label: "Appointment Map", icon: Map },
  { path: "/deals",         label: "Deals",         icon: TrendingUp },
  { path: "/reports",       label: "Reports",       icon: FileBarChart },
  { path: "/settings",      label: "Settings",      icon: Settings },
];

function NavItem({ path, label, icon: Icon, active, collapsed }) {
  const [tooltipPos, setTooltipPos] = useState(null);
  const timerRef = useRef(null);
  const linkRef = useRef(null);

  const handleMouseEnter = () => {
    if (!collapsed) return;
    timerRef.current = setTimeout(() => {
      if (linkRef.current) {
        const rect = linkRef.current.getBoundingClientRect();
        setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
      }
    }, 300);
  };

  const handleMouseLeave = () => {
    clearTimeout(timerRef.current);
    setTooltipPos(null);
  };

  return (
    <>
      <Link
        ref={linkRef}
        to={path}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={`relative flex items-center gap-3 px-2.5 py-2.5 rounded-lg group
          ${active
            ? "bg-amber-600/20 text-amber-400"
            : "text-white/60 hover:bg-white/8 hover:text-white"
          }`}
      >
        {active && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-500 rounded-r-full" />
        )}
        <Icon
          className={`w-5 h-5 flex-shrink-0 transition-colors ${active ? "text-amber-400" : "text-white/50 group-hover:text-white"}`}
          strokeWidth={1.75}
        />
        {!collapsed && (
          <span className={`text-xs font-semibold tracking-wide whitespace-nowrap ${active ? "text-amber-300" : ""}`}>
            {label}
          </span>
        )}
      </Link>
      {tooltipPos && createPortal(
        <div
          style={{
            position: 'fixed',
            top: tooltipPos.top,
            left: tooltipPos.left,
            transform: 'translateY(-50%)',
            zIndex: 99999,
            pointerEvents: 'none',
          }}
          className="bg-slate-900 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg shadow-lg shadow-black/30 whitespace-nowrap border border-white/10"
        >
          {label}
        </div>,
        document.body
      )}
    </>
  );
}

function LayoutComponent() {
  const [collapsed, setCollapsed] = useState(true);
  const location = useLocation();
  const { user: currentUser, logout } = useAuth();
  const isMobile = useIsMobile();
  // Local static asset — zero runtime dependency on Base44 media.
  // A company_logo_url from the API overrides this if set.
  const LOCAL_LOGO_URL = '/logo-dark.jpg';
  const [logoUrl, setLogoUrl] = useState(LOCAL_LOGO_URL);

  useEffect(() => {
    railwayCompanySettings.get()
      .then(data => {
        const settings = data?.settings;
        if (settings?.company_logo_url) setLogoUrl(settings.company_logo_url);
      })
      .catch(() => {});
  }, []);

  const NAV_ITEMS = currentUser?.role === 'sales_rep' ? NAV_ITEMS_SALES_REP : NAV_ITEMS_ALL;

  const isActive = (path) =>
    path === "/" ? location.pathname === "/" : location.pathname === path || location.pathname.startsWith(path + "/");

  if (isMobile) {
    return (
      <main
        className="flex-1 overflow-auto bg-slate-50"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top) + 12px)',
          paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
        }}
      >
        <Outlet />
      </main>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar - Locked width, no transitions, no movement */}
      <aside
        className="flex flex-col bg-[#1B2A4A] text-white border-r border-white/10"
        style={{ 
          width: collapsed ? 64 : 224,
          flexShrink: 0,
          contain: 'layout'
        }}
      >
        {/* Logo / Brand */}
        <div className="flex items-center border-b border-white/10 h-24 flex-shrink-0" style={{ padding: collapsed ? '0.75rem' : '0.75rem 1rem' }}>
          <div className="flex items-center" style={{ width: '100%', justifyContent: collapsed ? 'center' : 'flex-start', gap: collapsed ? 0 : '0.75rem' }}>
            {logoUrl ? (
              <img src={logoUrl} alt="EC Construction Group" style={{ height: 56, width: 56, flexShrink: 0, objectFit: 'contain' }} className="rounded-lg" />
            ) : (
              <div
                style={{ height: 56, width: 56, flexShrink: 0 }}
                className="flex items-center justify-center bg-amber-500 rounded-lg text-white font-bold text-lg"
              >
                EC
              </div>
            )}
            {!collapsed && (
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                <div className="text-white font-bold text-xs leading-tight">EC Construction</div>
                <div className="text-white/40 text-[10px]">Los Angeles, CA</div>
              </div>
            )}
          </div>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-hidden">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <NavItem key={path} path={path} label={label} icon={Icon} active={isActive(path)} collapsed={collapsed} />
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-3 space-y-2">
          {!collapsed && currentUser && (
            <div className="px-1 pb-1">
              <div className="text-white text-xs font-semibold truncate">{currentUser.full_name}</div>
              <div className="text-white/40 text-[10px] truncate mt-0.5">{currentUser.email}</div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Tip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
              <button
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/8 hover:bg-amber-600/20 text-white/60 hover:text-amber-400 transition-all duration-200"
              >
                {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
              </button>
            </Tip>
            {!collapsed && (
              <button
                onClick={() => logout()}
                className="flex items-center gap-2 text-white/50 hover:text-white text-xs font-semibold transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            )}
            {collapsed && (
              <Tip label="Logout" side="right">
                <button
                  onClick={() => logout()}
                  aria-label="Logout"
                  className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/8 hover:bg-red-500/20 text-white/60 hover:text-red-400 transition-all duration-200"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </Tip>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content - Reserved scrollbar space, independent scroll */}
      <main className="flex-1 overflow-auto bg-slate-50" style={{ scrollbarGutter: 'stable' }}>
        <Outlet />
      </main>
    </div>
  );
}

// Memoize Layout to prevent remounting on route changes
export default React.memo(LayoutComponent);
