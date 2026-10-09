import { Outlet, Link, useLocation } from "react-router-dom";
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import React from "react";
import {
  Users, BarChart2,
  Settings, ChevronLeft, ChevronRight, LogOut, TrendingUp, FileBarChart, Kanban, CalendarDays, Activity, Building2
} from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { useIsMobile } from "@/hooks/use-mobile";
import Tip from "@/components/ui/Tip";
import QBReconnectBanner from "@/components/QBReconnectBanner";
import * as railwayCompanySettings from "@/api/railway/companySettings";
import { hexToHslTriplet } from "@/lib/brandColor";
// Logo uses local static asset — no runtime API dependency

// Company identity fallback for this deployment (company #1). A future
// second deployment sets its own company_settings row via Company Setup —
// the shell itself never hardcodes a company beyond this default.
const DEFAULT_COMPANY_NAME = "EC Construction Group";
const DEFAULT_COMPANY_LOCATION = "Los Angeles, CA";

// A single nav list for every role — NAV_ITEMS_ALL/NAV_ITEMS_SALES_REP used to
// be two separately-maintained arrays with identical contents (scaffolded
// role differentiation that was never actually implemented). Kept as one
// list until a real per-role navigation decision is made; splitting it again
// is one line once that decision exists.
// My Day and Appointment Map used to be two separate primary destinations
// for the same daily scheduling/routing workflow. My Day's List/Map toggle
// (its Map view reuses the canonical Daily Map implementation — see
// pages/MobileDayView.jsx) is now the single canonical entry point;
// '/daily-map' remains a route for backward-compatible deep links (see
// App.jsx) but is no longer a competing sidebar destination.
const NAV_ITEMS = [
  { path: "/",              label: "Dashboard",       icon: BarChart2 },
  { path: "/my-day",        label: "My Day",          icon: CalendarDays },
  { path: "/leads",         label: "Active Leads",    icon: Users },
  { path: "/kanban",        label: "Status Board",    icon: Kanban },
  { path: "/deals",         label: "Deals",           icon: TrendingUp },
  { path: "/reports",       label: "Reports",         icon: FileBarChart },
  { path: "/settings",      label: "Settings",        icon: Settings },
  // Admin-only in practice (the page itself and the backend both enforce
  // this — see pages/SystemHealth.jsx and routes/systemInfo.js) but listed
  // for everyone here, matching this array's existing no-role-filtering
  // convention (see the comment above NAV_ITEMS) rather than introducing a
  // new, first-of-its-kind role-gated nav mechanism in this pass.
  { path: "/system-health", label: "System Health",   icon: Activity },
];

// Platform-admin-only (PRODUCTIZATION — multi-company onboarding workflow).
// Deliberately filtered by user.is_platform_admin below rather than added
// to NAV_ITEMS directly — unlike every item above (shown to everyone
// regardless of role, see the comment above NAV_ITEMS), showing a "Company
// Management" link to every user of every company it would always 403 for
// is a genuine UX/security-perception problem a non-filtered nav can't
// avoid, so this one first-of-its-kind role-gated nav entry is justified.
const PLATFORM_NAV_ITEM = { path: "/platform/companies", label: "Company Management", icon: Building2 };

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
  // Default to expanded: a collapsed, icon-only sidebar as the PERMANENT
  // desktop shell made every first-time/commercial view of the app look
  // like a miniature admin tool with a tiny logo, not a real navigation
  // shell. Persist whatever the user actually chooses across reloads.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar_collapsed') === 'true'; } catch { return false; }
  });
  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('sidebar_collapsed', String(next)); } catch { /* best-effort only */ }
      return next;
    });
  };
  const location = useLocation();
  const { user: currentUser, logout } = useAuth();
  const isMobile = useIsMobile();
  // Static fallback asset — used until (or unless) company_logo_url loads
  // successfully. PRODUCTIZATION PHASE 2: a prior DB-driven logo attempt
  // (see CLAUDE.md) broke production because a bad/missing URL rendered a
  // broken image with no fallback. This time: default to the static asset
  // immediately (no flash of a broken image), only swap to
  // company_logo_url once the browser has actually loaded it, and revert
  // to the static asset via onError if it fails at any point (deleted
  // file, bad URL, network blip) — never a silently broken <img>.
  const DEFAULT_LOGO_URL = '/logo-dark.jpg';
  const [logoUrl, setLogoUrl] = useState(DEFAULT_LOGO_URL);
  const [logoErrored, setLogoErrored] = useState(false);

  // Company identity comes from the canonical Company Settings singleton
  // (routes/companySettings.js) rather than being hardcoded per deployment —
  // a second company's deployment sets its own row via Company Setup and
  // this shell renders it unchanged. Falls back to this deployment's known
  // values until Company Setup has been used, or if the fetch fails.
  const [companyIdentity, setCompanyIdentity] = useState({
    name: DEFAULT_COMPANY_NAME,
    location: DEFAULT_COMPANY_LOCATION,
    faviconUrl: null,
    brandPrimaryColor: null,
  });
  useEffect(() => {
    let cancelled = false;
    railwayCompanySettings.get().then(res => {
      if (cancelled) return;
      const settings = res?.settings;
      if (!settings) return;
      // company_region (e.g. "SoCal", "NorCal", "SoCal + NorCal") is an
      // explicit admin-configured operational label — preferred over the
      // raw city/state line when set, since a single city/state pair can't
      // represent an admin/global view covering multiple regions. Never
      // inferred from an employee's name or email.
      setCompanyIdentity({
        name: settings.company_name || DEFAULT_COMPANY_NAME,
        location: settings.company_region
          || ((settings.company_city && settings.company_state)
            ? `${settings.company_city}, ${settings.company_state}`
            : DEFAULT_COMPANY_LOCATION),
        faviconUrl: settings.favicon_url || null,
        brandPrimaryColor: settings.brand_primary_color || null,
      });
      // Only swap the visible logo once a configured URL has actually
      // finished loading in the browser — a failed preload (404, CORS,
      // deleted file) leaves the static default in place, it never shows
      // a broken image.
      if (settings.company_logo_url) {
        const preload = new Image();
        preload.onload = () => { if (!cancelled) setLogoUrl(settings.company_logo_url); };
        preload.onerror = () => { /* keep the static default */ };
        preload.src = settings.company_logo_url;
      }
    }).catch(() => { /* keep defaults on failure */ });
    return () => { cancelled = true; };
  }, []);

  // Browser tab title + favicon — same "static default, upgrade only on
  // proven success" model as the sidebar logo above.
  useEffect(() => {
    document.title = companyIdentity.name ? `${companyIdentity.name} CRM` : 'CRM';
  }, [companyIdentity.name]);
  useEffect(() => {
    if (!companyIdentity.faviconUrl) return;
    const preload = new Image();
    preload.onload = () => {
      let link = document.querySelector("link[rel~='icon']");
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.href = companyIdentity.faviconUrl;
    };
    preload.onerror = () => { /* keep the static default favicon from index.html */ };
    preload.src = companyIdentity.faviconUrl;
  }, [companyIdentity.faviconUrl]);

  // Brand accent color (company_settings.brand_primary_color — PRODUCTIZATION
  // PHASE 2) overrides the --primary CSS variable that shadcn/ui components
  // read throughout the app (index.css). Same "never break on a bad value"
  // discipline as the logo/favicon above: hexToHslTriplet returns null for
  // anything malformed, and this effect simply does nothing in that case —
  // the product-default amber token in index.css stays in effect.
  useEffect(() => {
    if (!companyIdentity.brandPrimaryColor) return;
    const hsl = hexToHslTriplet(companyIdentity.brandPrimaryColor);
    if (!hsl) return;
    try { document.documentElement.style.setProperty('--primary', hsl); } catch { /* best-effort only */ }
  }, [companyIdentity.brandPrimaryColor]);

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
        <QBReconnectBanner user={currentUser} />
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
          // Widened slightly (224 → 240) so the full company name has room
          // to wrap onto two clean lines instead of being clipped —
          // collapsed width (icon-only) is unchanged.
          width: collapsed ? 64 : 240,
          flexShrink: 0,
          contain: 'layout'
        }}
      >
        {/* Logo / Brand */}
        <div className="flex items-center border-b border-white/10 h-24 flex-shrink-0" style={{ padding: collapsed ? '0.75rem' : '0.75rem 1rem' }}>
          <div className="flex items-center" style={{ width: '100%', justifyContent: collapsed ? 'center' : 'flex-start', gap: collapsed ? 0 : '0.75rem' }}>
            {logoUrl && !logoErrored ? (
              <img
                src={logoUrl}
                alt={companyIdentity.name}
                style={{ height: 56, width: 56, flexShrink: 0, objectFit: 'contain' }}
                className="rounded-lg"
                onError={() => {
                  // A custom logo that fails at render time (not just at
                  // preload — e.g. evicted from cache) falls back to the
                  // static default and gets one fresh chance to render; if
                  // the static default itself ever fails, that's terminal —
                  // show the initials avatar instead of a broken image.
                  if (logoUrl !== DEFAULT_LOGO_URL) setLogoUrl(DEFAULT_LOGO_URL);
                  else setLogoErrored(true);
                }}
              />
            ) : (
              <div
                style={{ height: 56, width: 56, flexShrink: 0 }}
                className="flex items-center justify-center bg-amber-500 rounded-lg text-white font-bold text-lg"
              >
                {(companyIdentity.name || 'CRM').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
            )}
            {!collapsed && (
              // Full company name must stay readable — previously this
              // container forced whiteSpace:nowrap + ellipsis, truncating
              // "EC Construction Group" to "EC Construction Grou...".
              // Wrapping to two lines (e.g. "EC Construction" / "Group")
              // keeps the name intact without widening the sidebar much.
              <div style={{ minWidth: 0 }}>
                <div className="text-white font-bold text-xs leading-tight break-words">{companyIdentity.name}</div>
                <div className="text-white/40 text-[10px] leading-tight break-words mt-0.5">{companyIdentity.location}</div>
              </div>
            )}
          </div>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-hidden">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <NavItem key={path} path={path} label={label} icon={Icon} active={isActive(path)} collapsed={collapsed} />
          ))}
          {currentUser?.is_platform_admin && (
            <NavItem path={PLATFORM_NAV_ITEM.path} label={PLATFORM_NAV_ITEM.label} icon={PLATFORM_NAV_ITEM.icon}
              active={isActive(PLATFORM_NAV_ITEM.path)} collapsed={collapsed} />
          )}
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
                onClick={toggleCollapsed}
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
        <QBReconnectBanner user={currentUser} />
        <Outlet />
      </main>
    </div>
  );
}

// Memoize Layout to prevent remounting on route changes
export default React.memo(LayoutComponent);