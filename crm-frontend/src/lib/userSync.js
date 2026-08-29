/**
 * User Sync Utilities
 * Ensures app-wide synchronization when user details change
 */

import * as railwayLeads from '@/api/railway/leads';
import * as railwayApi from '@/lib/railwayApi';

export async function syncAdminEmailChange(oldEmail, newEmail) {
  try {
    console.log(`[userSync] Syncing admin email change: ${oldEmail} → ${newEmail}`);
    
    // Update all createdBy references
    const leads = await railwayLeads.list({}).then(r => r.items || []);
    const leadsToUpdate = leads.filter(l => l.created_by === oldEmail);
    
    for (const lead of leadsToUpdate) {
      try {
        await railwayLeads.update(lead.id, { created_by: newEmail });
      } catch (err) {
        console.warn(`Failed to update lead ${lead.id}:`, err.message);
      }
    }
    
    console.log(`[userSync] Updated ${leadsToUpdate.length} lead ownership records`);
    return { success: true, updatedLeads: leadsToUpdate.length };
  } catch (err) {
    console.error('[userSync] Sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

export async function getCurrentAdminEmail() {
  try {
    const meResp = await railwayApi.me();
    return meResp?.user?.email;
  } catch {
    return null;
  }
}