import { normalizeIntegrationError } from '@/lib/railwayClient';

/**
 * Normalizes integration errors into user-friendly messages.
 * Never surfaces Base44 plan/subscription errors to users.
 */
export function friendlyFnError(e) {
  return normalizeIntegrationError(e);
}