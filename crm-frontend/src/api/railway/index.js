/**
 * railway API — permanent frontend API layer. Replaces the legacy SDK
 * entity, function-invoke, and auth call patterns across the CRM,
 * service-by-service.
 *
 * Import from @/api/railway in new/migrated code. Existing code that imports
 * from @/lib/railwayApi keeps working (railwayApi.js re-exports these).
 */

export * from './client';
export * as auth from './auth';
export * as leads from './leads';
export * as activities from './activities';
export * as owners from './owners';
export * as deals from './deals';
export * as settings from './settings';
export * as tasks from './tasks';
export * as invoices from './invoices';
export * as dealExpenses from './dealExpenses';
export * as dealExpensePayments from './dealExpensePayments';
export * as dealCommissions from './dealCommissions';
export * as dealLoanPayments from './dealLoanPayments';
export * as properties from './properties';
export * as leadAttachments from './leadAttachments';
export * as handoffEstimates from './handoffEstimates';
export * as syncCursors from './syncCursors';
export * as companySettings from './companySettings';
export * as leadQB from './leadQB';
export * as signnow from './signnow';
export * as leadSubmissions from './leadSubmissions';