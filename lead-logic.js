/**
 * Shared lead pipeline logic for the Coolify admin tracker.
 * Keep filter rules here so we can unit-test without loading the full server.
 */

const TERMINAL_STATUSES = new Set(['sent', 'replied', 'dead', 'in_progress']);

const STATUS_RANK = {
  new: 1,
  live: 2,
  pending: 3,
  ready: 4,
  in_progress: 5,
  sent: 6,
  replied: 7,
  dead: 8,
};

function clean(value) {
  return value && value !== '—' ? String(value).trim() : '';
}

function mergeStatus(csvStatus, overrideStatus) {
  const csv = csvStatus || 'new';
  const override = clean(overrideStatus);
  if (!override) return csv;
  const csvRank = STATUS_RANK[csv] || 0;
  const overrideRank = STATUS_RANK[override] || 0;
  return overrideRank >= csvRank ? override : csv;
}

function mergeLead(csvLead, override = {}) {
  const key = businessKey(csvLead.business);
  const merged = { ...csvLead, ...override, business: csvLead.business, key };
  merged.base_status = csvLead.status || 'new';
  merged.status = mergeStatus(csvLead.status, override.status);
  merged.outreach_method = clean(override.outreach_method) || clean(csvLead.outreach_method);
  merged.outreach_date = clean(override.outreach_date) || clean(csvLead.outreach_date);
  return merged;
}

function businessKey(name) {
  return (
    String(name || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

function normalizedPhone(lead) {
  return String(lead.phone || '').replace(/\D/g, '').replace(/^1/, '');
}

function isTollFreePhone(lead) {
  return /^(800|833|844|855|866|877|888)/.test(normalizedPhone(lead));
}

function hasDemo(lead) {
  return Boolean(clean(lead.demo_url)) && !String(lead.demo_url).includes('TBD');
}

function hasPhone(lead) {
  return Boolean(clean(lead.phone));
}

function hasEmail(lead) {
  return Boolean(clean(lead.email));
}

function hasSocial(lead) {
  return Boolean(clean(lead.social));
}

function hasOutreachRoute(lead) {
  return hasEmail(lead) || hasSocial(lead) || (hasPhone(lead) && !isTollFreePhone(lead));
}

function alreadyContacted(lead) {
  if (TERMINAL_STATUSES.has(lead.status)) return true;
  if (clean(lead.outreach_date)) return true;
  if (clean(lead.outreach_method)) return true;
  return false;
}

function inferredWebsiteStatus(lead) {
  if (clean(lead.website_status)) return lead.website_status;
  const notes = String(lead.notes || '').toLowerCase();
  if (lead.status === 'dead' && (notes.includes('website') || notes.includes('domain'))) {
    return 'has_website';
  }
  const noWebsiteHints = [
    'verified no website',
    'no official website',
    'no official site',
    'does not resolve',
    "doesn't resolve",
    'domain does not resolve',
    'no working official site',
    'ok to pitch',
  ];
  if (noWebsiteHints.some((hint) => notes.includes(hint))) return 'no_website';
  if (lead.status === 'live' || (hasDemo(lead) && notes.includes('demo deployed'))) {
    return 'no_website';
  }
  return 'needs_verify';
}

function inferredPhoneStatus(lead) {
  if (isTollFreePhone(lead)) return 'not_textable';
  return lead.phone_status || (hasPhone(lead) ? 'unverified' : 'wrong');
}

function isTextablePhone(lead) {
  return inferredPhoneStatus(lead) === 'verified' && hasPhone(lead) && !isTollFreePhone(lead);
}

function canUsePhoneForOutreach(lead) {
  return hasPhone(lead) && !isTollFreePhone(lead) && !alreadyContacted(lead);
}

function isOpenForOutreach(lead) {
  return !TERMINAL_STATUSES.has(lead.status);
}

function readyToReachOut(lead) {
  if (alreadyContacted(lead)) return false;
  if (inferredWebsiteStatus(lead) === 'has_website') return false;
  if (lead.status === 'ready') return true;
  return (
    isOpenForOutreach(lead)
    && inferredWebsiteStatus(lead) === 'no_website'
    && hasDemo(lead)
    && hasOutreachRoute(lead)
  );
}

function readyToText(lead) {
  if (alreadyContacted(lead)) return false;
  return (
    isOpenForOutreach(lead)
    && inferredWebsiteStatus(lead) === 'no_website'
    && isTextablePhone(lead)
    && hasDemo(lead)
  );
}

function readyToEmail(lead) {
  if (alreadyContacted(lead)) return false;
  return (
    isOpenForOutreach(lead)
    && inferredWebsiteStatus(lead) === 'no_website'
    && (lead.email_status || 'missing') !== 'bounced'
    && hasEmail(lead)
    && hasDemo(lead)
  );
}

function needsFollowUp(lead) {
  return lead.status === 'sent' || lead.status === 'replied';
}

module.exports = {
  clean,
  mergeStatus,
  mergeLead,
  alreadyContacted,
  readyToReachOut,
  readyToText,
  needsFollowUp,
  canUsePhoneForOutreach,
  inferredWebsiteStatus,
};
