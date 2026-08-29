// Rebuild trigger 2026-08-28: force Base44 published app to serve current
// Railway-only code (fixes stale bundle: Activity writes, ContactInfoEditor pencils,
// Dashboard/Deals metrics — all three defects traced to stale build index-CHwSslG8.js)
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useLocation, Navigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { isExitBuild } from '@/lib/app-params';
import { SyncProvider } from '@/lib/syncContext';
import SyncStatusPremium from '@/components/SyncStatusPremium';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import MobileNav from '@/components/MobileNav';
import FollowUpReminderPopup from '@/components/FollowUpReminderPopup';
// Add page imports here
import MyDiag from './pages/MyDiag';
import Login from './pages/Login';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Leads from './pages/LeadsModern';
import LeadDetailModern from './pages/LeadDetailModern';
import LeadCapture from './pages/LeadCapture';
import Estimates from './pages/EstimatesModern';
import EstimateDetail from './pages/EstimateDetail';
import Settings from './pages/Settings';
import Integrations from './pages/Integrations';
import QBCallback from './pages/QBCallback';
import DealDetail from './pages/DealDetail';
import Deals from './pages/Deals';
import DailyMap from './pages/DailyMap';
import AutomationCenter from './pages/AutomationCenter';
import DailyActionCenter from './pages/DailyActionCenter';
import Reports from './pages/Reports';
import MobileDayView from './pages/MobileDayView';
import KanbanBoard from './pages/KanbanBoard';

// Page content wrapper with transition (only wraps page content, not Layout)
const PageContentWrapper = ({ children }) => {
  const location = useLocation();
  const isPublicRoute = ['/capture'].includes(location.pathname);

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, x: isPublicRoute ? 0 : 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.2 }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
};

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin, checkAppState, user } = useAuth();

  // Public routes — skip auth checks entirely
  const isPublicRoute = ['/capture', '/login'].includes(window.location.pathname);
  if (isPublicRoute) {
    return (
      <Routes>
        <Route path="/capture" element={<LeadCapture />} />
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
        <p className="text-xs text-slate-400">Loading EC CRM…</p>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered' || authError.type === 'user_not_authorized') {
      return <UserNotRegisteredError authError={authError} user={user} />;
    } else if (authError.type === 'auth_required') {
      // Railway auth: route to the native login page (Google SSO + email/password).
      return <Navigate to="/login" replace />;
    } else if (authError.type === 'network_error') {
      // Timeout or connection failure — show retry screen instead of infinite spinner
      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center bg-white">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-slate-800">Connection problem</p>
            <p className="text-sm text-slate-500 mt-1">{authError.message}</p>
          </div>
          <button
            onClick={checkAppState}
            className="px-5 py-2.5 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-800 active:scale-95 transition-all"
          >
            Retry
          </button>
          <button
            onClick={() => { localStorage.clear(); navigateToLogin(); }}
            className="text-xs text-slate-400 underline"
          >
            Clear session &amp; sign in again
          </button>
        </div>
      );
    }
  }

  // Render the main app — Layout wraps Routes (sidebar stays mounted, only page content changes)
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<PageContentWrapper><Dashboard /></PageContentWrapper>} />
        <Route path="/daily-map" element={<PageContentWrapper><DailyMap /></PageContentWrapper>} />
        <Route path="/my-day" element={<PageContentWrapper><MobileDayView /></PageContentWrapper>} />
        <Route path="/kanban" element={<PageContentWrapper><KanbanBoard /></PageContentWrapper>} />
        <Route path="/automations" element={<PageContentWrapper><AutomationCenter /></PageContentWrapper>} />
        <Route path="/leads" element={<PageContentWrapper><Leads /></PageContentWrapper>} />
        <Route path="/leads/:id" element={<PageContentWrapper><LeadDetailModern /></PageContentWrapper>} />
        <Route path="/estimates" element={<PageContentWrapper><Estimates /></PageContentWrapper>} />
        <Route path="/estimates/:id" element={<PageContentWrapper><EstimateDetail /></PageContentWrapper>} />
        <Route path="/deals" element={<PageContentWrapper><Deals /></PageContentWrapper>} />
        <Route path="/deals/:id" element={<PageContentWrapper><DealDetail /></PageContentWrapper>} />
        <Route path="/reports" element={<PageContentWrapper><Reports /></PageContentWrapper>} />
        <Route path="/settings" element={<PageContentWrapper><Settings /></PageContentWrapper>} />
        <Route path="/integrations" element={<PageContentWrapper><Integrations /></PageContentWrapper>} />
      </Route>
      <Route path="/qb-callback" element={<QBCallback />} />
      <Route path="/my-diag" element={<MyDiag />} />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <SyncProvider>
        <QueryClientProvider client={queryClientInstance}>
          <TooltipProvider>
          <Router>
            <div className="flex flex-col h-screen" data-build="2026-08-28-railway-only">
              <AuthenticatedApp />
              <MobileNav />
              <SyncStatusPremium />
              <FollowUpReminderPopup />
            </div>
          </Router>
          <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </SyncProvider>
    </AuthProvider>
  )
}

export default App