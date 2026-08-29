import { useLocation, useNavigate } from 'react-router-dom';
import { useIsMobile } from '@/hooks/use-mobile';
import { LayoutDashboard, Users, Briefcase, CalendarDays } from 'lucide-react';
import { useRef } from 'react';

const MOBILE_NAV_ITEMS = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/leads', icon: Users, label: 'Leads' },
  { path: '/my-day', icon: CalendarDays, label: 'My Day' },
  { path: '/deals', icon: Briefcase, label: 'Deals' },

];

// Per-tab history stacks — persist across renders (module-level)
const tabStacks = {};
MOBILE_NAV_ITEMS.forEach(({ path }) => { tabStacks[path] = [path]; });

export default function MobileNav() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  // Track which root tab the current path belongs to
  const activeRoot = MOBILE_NAV_ITEMS.slice().reverse().find(
    ({ path }) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path))
  )?.path || '/';

  // Keep the tab stack updated as the user navigates
  const prevPathRef = useRef(location.pathname);
  if (prevPathRef.current !== location.pathname) {
    // Push to the current tab's stack (avoid duplicates at top)
    if (tabStacks[activeRoot].at(-1) !== location.pathname) {
      tabStacks[activeRoot].push(location.pathname);
    }
    prevPathRef.current = location.pathname;
  }

  if (!isMobile) return null;

  const handleTabPress = (path) => {
    if (path === activeRoot) {
      // Re-tapping the active tab resets to root
      tabStacks[path] = [path];
      navigate(path, { replace: true });
    } else {
      // Switch to this tab — restore last position in its stack
      const stack = tabStacks[path];
      const dest = stack.at(-1) || path;
      navigate(dest);
    }
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      <div className="flex justify-around items-stretch h-16">
        {MOBILE_NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const isActive = path === activeRoot;
          return (
            <button
              key={path}
              onClick={() => handleTabPress(path)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors ${
                isActive
                  ? 'text-amber-600 bg-amber-50'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}