/**
 * Unified Card Component System
 * Provides consistent styling for all card types across the CRM
 */

import React from 'react';
import { AlertTriangle, AlertCircle, CheckCircle2, Info, Zap } from 'lucide-react';

/**
 * StandardCard - Default container for content sections
 */
export function StandardCard({ children, className = '' }) {
  return (
    <div className={`bg-card text-card-foreground border border-border rounded-lg p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/**
 * InfoCard - Informational messages with soft blue background
 */
export function InfoCard({ icon, title, description, action = null }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {icon || <Info className="w-4 h-4 text-blue-600" />}
        </div>
        <div className="flex-1 min-w-0">
          {title && <h3 className="typography-message-title text-blue-900">{title}</h3>}
          {description && <p className="text-sm text-blue-700 mt-1">{description}</p>}
        </div>
      </div>
      {action && <div className="ml-7">{action}</div>}
    </div>
  );
}

/**
 * WarningCard - Warning/caution messages with amber background
 */
export function WarningCard({ icon, title, description, action = null }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {icon || <AlertTriangle className="w-4 h-4 text-amber-600" />}
        </div>
        <div className="flex-1 min-w-0">
          {title && <h3 className="typography-message-title text-amber-900">{title}</h3>}
          {description && <p className="text-sm text-amber-700 mt-1">{description}</p>}
        </div>
      </div>
      {action && <div className="ml-7">{action}</div>}
    </div>
  );
}

/**
 * ErrorCard - Error messages with red background
 */
export function ErrorCard({ icon, title, description, action = null }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {icon || <AlertTriangle className="w-4 h-4 text-red-600" />}
        </div>
        <div className="flex-1 min-w-0">
          {title && <h3 className="typography-message-title text-red-900">{title}</h3>}
          {description && <p className="text-sm text-red-700 mt-1">{description}</p>}
        </div>
      </div>
      {action && <div className="ml-7">{action}</div>}
    </div>
  );
}

/**
 * SuccessCard - Success/confirmation messages with green background
 */
export function SuccessCard({ icon, title, description, action = null }) {
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {icon || <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        </div>
        <div className="flex-1 min-w-0">
          {title && <h3 className="typography-message-title text-emerald-900">{title}</h3>}
          {description && <p className="text-sm text-emerald-700 mt-1">{description}</p>}
        </div>
      </div>
      {action && <div className="ml-7">{action}</div>}
    </div>
  );
}

/**
 * EmptyStateCard - Large empty state with icon, title, and optional action
 */
export function EmptyStateCard({ icon, title, description, action = null, className = '' }) {
  return (
    <div className={`border-2 border-dashed border-border rounded-lg p-8 text-center space-y-3 ${className}`}>
      {icon && (
        <div className="flex justify-center">
          {React.isValidElement(icon) ? icon : <div className="text-slate-300">{icon}</div>}
        </div>
      )}
      {title && <h3 className="typography-empty-state-title">{title}</h3>}
      {description && <p className="text-sm text-slate-500">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/**
 * SectionCard - Card with optional header and consistent spacing
 */
export function SectionCard({ title, subtitle, children, className = '', headerAction = null }) {
  return (
    <StandardCard className={className}>
      {(title || subtitle || headerAction) && (
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
          <div>
            {title && <h2 className="typography-card-title">{title}</h2>}
            {subtitle && <p className="typography-helper-text mt-1">{subtitle}</p>}
          </div>
          {headerAction && <div>{headerAction}</div>}
        </div>
      )}
      {children}
    </StandardCard>
  );
}

/**
 * StatusBadge - Consistent status indicator
 */
export function StatusBadge({ status, size = 'sm' }) {
  const styles = {
    success: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
    info: 'bg-blue-100 text-blue-700',
    default: 'bg-slate-100 text-slate-700',
  };

  const sizeClasses = {
    xs: 'px-2 py-0.5 text-[10px] font-semibold',
    sm: 'px-2.5 py-1 text-xs font-semibold',
    md: 'px-3 py-1.5 text-sm font-semibold',
  };

  const [type, label] = typeof status === 'string' 
    ? ['default', status] 
    : [status.type || 'default', status.label];

  return (
    <span className={`rounded-md ${styles[type] || styles.default} ${sizeClasses[size] || sizeClasses.sm}`}>
      {label}
    </span>
  );
}