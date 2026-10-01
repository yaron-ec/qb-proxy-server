import { useEffect, useState } from 'react';
import * as railwayCompanySettings from '@/api/railway/companySettings';

const EC_DOMAIN = 'ecconstructiongroup.com';

/**
 * This installation's configured email domain (derived from
 * company_settings.company_email/admin_email — same resolution as the
 * backend's lib/companyConfig.js#getCompanyEmailDomain), for client-side
 * owner-email resolution (see crm-frontend/src/lib/ownerEmailMap.js).
 * Falls back to EC's domain only until configured/on fetch failure, never
 * blocking render.
 */
export function useCompanyEmailDomain() {
  const [domain, setDomain] = useState(EC_DOMAIN);

  useEffect(() => {
    let cancelled = false;
    railwayCompanySettings.get()
      .then((cfg) => {
        if (cancelled) return;
        const email = cfg?.company_email || cfg?.admin_email;
        const d = email && email.includes('@') ? email.split('@')[1] : null;
        if (d) setDomain(d);
      })
      .catch(() => { /* keep EC_DOMAIN fallback */ });
    return () => { cancelled = true; };
  }, []);

  return domain;
}
