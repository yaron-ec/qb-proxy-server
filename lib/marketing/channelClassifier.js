/* eslint-disable no-undef */
/**
 * channelClassifier — deterministic, versioned classification of ONE
 * marketing touch into a marketing_channels code, plus normalized
 * source/medium derived ONLY from evidence present on the touch.
 *
 * Rules (v1), in priority order — the first rule with evidence wins:
 *   1. Explicit tagging for channels that cannot be detected otherwise:
 *        Business Profile  utm_source|utm_medium in gbp/gmb/google_business_profile/google_my_business
 *        Local Services    utm_source|utm_medium = lsa / local_services
 *        Offline           utm_medium in offline/print/direct_mail/qr/radio/tv/flyer/yard_sign/event/signage
 *        Partner           utm_medium in partner/affiliate
 *   2. Ad click identifiers: gclid/gbraid/wbraid/gad_source → Google Ads;
 *      msclkid → Microsoft Ads; fbclid → Meta.
 *   3. utm_source + paid medium (cpc/ppc/paid/paidsearch/paid_search/sem/
 *      display/paid_social): google → Google Ads, bing/microsoft → Microsoft
 *      Ads, facebook/instagram/meta/fb/ig → Meta.
 *   4. Other utm tagging: organic search medium → Organic Search (Google
 *      source stays "organic or Business Profile"), social sources → Meta,
 *      medium=referral → Referral, medium=email → Other, anything else → Other.
 *   5. External referrer: Google search → "Google Search — organic or
 *      Business Profile" (an untagged Business Profile website click is
 *      indistinguishable from an organic result, so it is NEVER guessed as
 *      either); other search engines → Organic Search; Facebook/Instagram →
 *      Meta; any other site → Referral.
 *   6. No referrer and no parameters → Direct.
 *
 * Nothing is fabricated: campaign/keyword/ad group are never inferred.
 */
'use strict';

const CLASSIFIER_VERSION = 'v1';

const low = (v) => (v == null ? '' : String(v).trim().toLowerCase());

const GBP_TOKENS = new Set(['gbp', 'gmb', 'google_business_profile', 'google-business-profile', 'google_my_business', 'googlemybusiness', 'business_profile']);
const LSA_TOKENS = new Set(['lsa', 'local_services', 'local-services', 'local_services_ads', 'google_lsa']);
const OFFLINE_MEDIUMS = new Set(['offline', 'print', 'direct_mail', 'directmail', 'mail', 'qr', 'qr_code', 'radio', 'tv', 'flyer', 'yard_sign', 'event', 'signage', 'billboard', 'vehicle']);
const PARTNER_MEDIUMS = new Set(['partner', 'affiliate']);
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'sem', 'display', 'paid_social', 'paidsocial', 'cpm']);
const GOOGLE_SOURCES = new Set(['google', 'adwords', 'google_ads', 'googleads']);
const MICROSOFT_SOURCES = new Set(['bing', 'microsoft', 'msn', 'microsoft_ads']);
const META_SOURCES = new Set(['facebook', 'instagram', 'meta', 'fb', 'ig', 'facebook.com', 'instagram.com']);
const ORGANIC_MEDIUMS = new Set(['organic', 'seo']);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
const isGoogleHost = (h) => /(^|\.)google\.[a-z.]+$/.test(h) || h === 'google.com';
const SEARCH_HOSTS = [/(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)search\.yahoo\.com$/, /(^|\.)yahoo\.com$/, /(^|\.)ecosia\.org$/, /(^|\.)search\.brave\.com$/, /(^|\.)baidu\.com$/, /(^|\.)yandex\.[a-z]+$/];
const isOtherSearchHost = (h) => SEARCH_HOSTS.some((re) => re.test(h));
const isMetaHost = (h) => /(^|\.)(facebook|instagram|fb)\.com$/.test(h) || h === 'l.facebook.com' || h === 'lm.facebook.com';

/**
 * @param {object} t normalized touch (utm_*, click ids, referrer, landing_page)
 * @returns {{ channel_code, source, medium, classifier_version }}
 */
function classifyTouch(t = {}) {
  const us = low(t.utm_source);
  const um = low(t.utm_medium);
  const refHost = hostOf(t.referrer);
  const out = (channel_code, source, medium) => ({
    channel_code,
    source: t.utm_source || source || null,
    medium: t.utm_medium || medium || null,
    classifier_version: CLASSIFIER_VERSION,
  });

  // 1. Explicitly tagged channels
  if (GBP_TOKENS.has(us) || GBP_TOKENS.has(um)) return out('google_business_profile', 'google', 'gbp');
  if (LSA_TOKENS.has(us) || LSA_TOKENS.has(um)) return out('local_services_ads', 'google', 'lsa');
  if (OFFLINE_MEDIUMS.has(um)) return out('offline', null, null);
  if (PARTNER_MEDIUMS.has(um)) return out('partner', null, null);

  // 2. Ad click identifiers
  if (t.gclid || t.gbraid || t.wbraid || t.gad_source) return out('google_ads', 'google', 'cpc');
  if (t.msclkid) return out('microsoft_ads', 'bing', 'cpc');
  if (t.fbclid) return out('meta', 'facebook', refHost && isMetaHost(refHost) ? 'social' : null);

  // 3. Paid tagging
  if (PAID_MEDIUMS.has(um)) {
    if (GOOGLE_SOURCES.has(us)) return out('google_ads', 'google', 'cpc');
    if (MICROSOFT_SOURCES.has(us)) return out('microsoft_ads', 'bing', 'cpc');
    if (META_SOURCES.has(us)) return out('meta', 'facebook', 'paid_social');
    return out('other', null, null);
  }

  // 4. Other tagging
  if (us || um) {
    if (ORGANIC_MEDIUMS.has(um)) {
      if (GOOGLE_SOURCES.has(us)) return out('google_organic_or_gbp', 'google', 'organic');
      return out('organic_search', null, 'organic');
    }
    if (META_SOURCES.has(us)) return out('meta', 'facebook', null);
    if (um === 'referral') return out('referral', null, 'referral');
    return out('other', null, null);
  }

  // 5. Referrer
  if (refHost) {
    if (isGoogleHost(refHost)) return out('google_organic_or_gbp', 'google', 'organic');
    if (isOtherSearchHost(refHost)) return out('organic_search', refHost.replace(/^(search\.)/, '').split('.')[0], 'organic');
    if (isMetaHost(refHost)) return out('meta', refHost.includes('instagram') ? 'instagram' : 'facebook', 'social');
    return out('referral', refHost, 'referral');
  }

  // 6. Nothing
  return out('direct', '(direct)', '(none)');
}

/** A touch is "meaningful" (worth keeping as last touch) unless it is Direct. */
const isMeaningfulTouch = (t) => classifyTouch(t).channel_code !== 'direct';

module.exports = { CLASSIFIER_VERSION, classifyTouch, isMeaningfulTouch };
