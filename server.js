const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function envValue(name, fallback = '') {
  const value = process.env[name];
  if (!value) return fallback;
  return value.replace(/^['"]|['"]$/g, '');
}

const PORT = Number(envValue('PORT', '3000'));
const DATA_DIR = envValue('DATA_DIR', path.join(__dirname, 'data'));
const STATE_PATH = path.join(DATA_DIR, 'tracker-state.json');
const ADMIN_TOKEN = envValue('ADMIN_TOKEN');
const LEADS_CSV_URL = envValue('LEADS_CSV_URL', 'https://mexemexe02.github.io/barrie-lead-tracker/leads.csv');

const STATUS_VALUES = new Set(['new', 'ready', 'sent', 'pending', 'replied', 'dead', 'live', 'in_progress']);
const WEBSITE_STATUS_VALUES = new Set(['needs_verify', 'no_website', 'has_website', 'unclear']);
const PHONE_STATUS_VALUES = new Set(['unverified', 'verified', 'not_textable', 'wrong', 'duplicate']);
const EMAIL_STATUS_VALUES = new Set(['missing', 'found', 'unverified', 'bounced']);
const OWNER_STATUS_VALUES = new Set(['missing', 'found', 'unclear']);

function businessKey(name) {
  return String(name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    return { overrides: {}, history: [] };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { overrides: {}, history: [] };
  }
}

function saveState(state) {
  ensureDataDir();
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, STATE_PATH);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Fetch failed: ${response.statusCode}`));
          response.resume();
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

async function loadLeads() {
  const csv = await fetchText(LEADS_CSV_URL);
  const state = loadState();

  return parseCsv(csv).map((lead) => {
    const key = businessKey(lead.business);
    const override = state.overrides[key] || {};

    return {
      ...lead,
      ...override,
      business: lead.business,
      key,
      base_status: lead.status || 'new',
      status: override.status || lead.status || 'new',
    };
  });
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
  });
}

function isAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  sendJson(res, 401, { error: 'Missing or invalid admin token.' });
  return false;
}

function upsertOverride(payload) {
  const key = payload.key || businessKey(payload.business);
  const state = loadState();
  const current = state.overrides[key] || {};
  const next = { ...current };

  [
    'contact_name',
    'email',
    'social',
    'notes',
    'outreach_method',
    'outreach_date',
    'website_status',
    'website_evidence',
    'phone_status',
    'phone_source',
    'email_status',
    'email_source',
    'owner_status',
    'owner_source',
    'next_action',
    'follow_up_date',
    'last_verified',
    'dead_reason',
  ].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      next[field] = String(payload[field] || '').trim();
    }
  });

  if (payload.status) {
    if (!STATUS_VALUES.has(payload.status)) {
      throw new Error(`Invalid status: ${payload.status}`);
    }
    next.status = payload.status;
  }

  if (next.website_status && !WEBSITE_STATUS_VALUES.has(next.website_status)) {
    throw new Error(`Invalid website status: ${next.website_status}`);
  }
  if (next.phone_status && !PHONE_STATUS_VALUES.has(next.phone_status)) {
    throw new Error(`Invalid phone status: ${next.phone_status}`);
  }
  if (next.email_status && !EMAIL_STATUS_VALUES.has(next.email_status)) {
    throw new Error(`Invalid email status: ${next.email_status}`);
  }
  if (next.owner_status && !OWNER_STATUS_VALUES.has(next.owner_status)) {
    throw new Error(`Invalid owner status: ${next.owner_status}`);
  }

  if (next.website_status === 'has_website') {
    next.status = 'dead';
    next.next_action = 'do_not_contact';
  }

  if (next.status === 'sent') {
    next.outreach_date = next.outreach_date || new Date().toISOString().slice(0, 10);
    next.outreach_method = next.outreach_method || 'manual';
    next.next_action = next.next_action || 'follow_up';
  }

  if (next.status === 'replied') {
    next.next_action = next.next_action || 'follow_up';
  }

  if (next.status === 'dead' && !next.dead_reason && !next.website_evidence && !next.notes) {
    throw new Error('Dead leads need notes, a dead reason, or website evidence.');
  }

  next.updated_at = new Date().toISOString();
  state.overrides[key] = next;
  state.history = state.history || [];
  state.history.push({ key, change: payload, at: next.updated_at });
  state.history = state.history.slice(-500);
  saveState(state);

  return { key, override: next };
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Barrie Lead Admin Tracker</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; background: #0f1117; color: #e8e8e8; font-family: Inter, system-ui, sans-serif; }
    h1 { margin: 0 0 8px; color: #c9a84c; font-size: 1.35rem; }
    p { color: #999; margin: 0 0 18px; }
    .bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    .view-buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .message { background: #1a1d2a; border: 1px solid #2a2d3a; border-radius: 8px; color: #d7c176; margin-bottom: 14px; padding: 10px 12px; }
    input, select, textarea, button { border: 1px solid #2a2d3a; border-radius: 6px; background: #161923; color: #eee; padding: 7px 9px; }
    button { cursor: pointer; background: #2a2413; color: #e4c66f; font-weight: 700; }
    button:hover { filter: brightness(1.15); }
    .view-buttons button.active { background: #5c4515; color: #fff1a8; }
    .copy-sms { background: #17314f; color: #8fc5ff; }
    .copy-email { background: #321d54; color: #d5b2ff; }
    .quick-sent { background: #123a2a; color: #83f0b1; }
    .quick-dead { background: #431b1b; color: #ff9a9a; }
    .quick-replied { background: #2d2054; color: #c9b4ff; }
    .save-btn { background: #2a2413; color: #e4c66f; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .stat { background: #1a1d2a; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
    .stat strong { color: #c9a84c; display: block; font-size: 1.25rem; }
    .wrap { overflow-x: auto; border: 1px solid #1f2330; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 2300px; font-size: 0.82rem; }
    th, td { border-bottom: 1px solid #1f2330; padding: 8px; vertical-align: top; text-align: left; }
    th { color: #c9a84c; background: #171a25; position: sticky; top: 0; }
    th:last-child, td:last-child { position: sticky; right: 0; min-width: 210px; max-width: 230px; box-shadow: -10px 0 16px rgba(15, 17, 23, 0.85); }
    th:last-child { z-index: 4; background: #171a25; }
    td:last-child { z-index: 2; background: #111520; border-left: 1px solid #2a2d3a; }
    .url { color: #70a7ff; word-break: break-all; }
    .tiny { color: #777; font-size: 0.72rem; }
    .status-new { color: #4ade80; }
    .status-ready { color: #facc15; }
    .status-sent { color: #60a5fa; }
    .status-dead { color: #ef7777; }
    .status-pending { color: #fbbf24; }
    .status-live { color: #4ade80; }
    .cell-input { width: 150px; }
    .wide-input { width: 230px; }
    .notes { width: 280px; min-height: 44px; }
    .action-stack { display: flex; flex-direction: column; gap: 5px; min-width: 190px; }
    .action-stack button { width: 100%; padding: 6px 8px; text-align: left; }
    .research-links a { display: inline-block; color: #70a7ff; margin: 0 6px 4px 0; text-decoration: none; }
    .score { color: #c9a84c; font-weight: 800; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #15351f; color: #7ee787; padding: 10px 18px; border-radius: 8px; opacity: 0; transition: opacity .2s; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <h1>Barrie Lead Admin Tracker</h1>
  <p>Persistent tracker backed by Coolify storage. No-website rule still applies: mark as dead if an official website is found.</p>
  <form class="bar" id="tokenForm">
    <input id="token" type="password" placeholder="Admin token">
    <button id="saveToken" type="submit">Save token</button>
    <input id="search" placeholder="Search business, phone, notes">
    <select id="statusFilter">
      <option value="">All statuses</option>
      <option value="new">new</option>
      <option value="ready">ready</option>
      <option value="sent">sent</option>
      <option value="dead">dead</option>
      <option value="pending">pending</option>
      <option value="live">live</option>
    </select>
    <select id="contactFilter">
      <option value="">All contacts</option>
      <option value="missing-owner">Missing owner</option>
      <option value="missing-email">Missing email</option>
      <option value="has-email">Has email</option>
      <option value="phone-only">Phone only</option>
    </select>
    <button id="reload" type="button">Reload</button>
  </form>
  <div id="message" class="message"></div>
  <div class="view-buttons" id="viewButtons">
    <button type="button" data-view="">All</button>
    <button type="button" data-view="ready-outreach">Ready Outreach</button>
    <button type="button" data-view="ready-text">Ready to Text</button>
    <button type="button" data-view="ready-email">Ready to Email</button>
    <button type="button" data-view="needs-email">Needs Email</button>
    <button type="button" data-view="needs-website">Needs Website Verify</button>
    <button type="button" data-view="phone-unverified">No Textable Phone</button>
    <button type="button" data-view="missing-owner">Missing Owner</button>
    <button type="button" data-view="missing-email">Missing Email</button>
    <button type="button" data-view="follow-up">Follow Up</button>
    <button type="button" data-view="replied">Replied</button>
    <button type="button" data-view="dead">Dead</button>
  </div>
  <div id="stats" class="stats"></div>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>#</th><th>Business</th><th>Score</th><th>Status</th><th>Website</th><th>Phone Verify</th>
          <th>Owner</th><th>Email</th><th>Phone</th><th>Social</th><th>Category</th><th>Demo URL</th>
          <th>Next Action</th><th>Follow Up</th><th>Research</th><th>Notes / Evidence</th><th>Action</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    let leads = [];
    let activeView = '';
    const tokenInput = document.getElementById('token');
    const message = document.getElementById('message');
    tokenInput.value = localStorage.getItem('barrie_admin_token') || '';

    function token() { return tokenInput.value.trim(); }
    function setMessage(text) { message.textContent = text; }
    function showToast(message) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1800);
    }
    function clean(value) { return value && value !== '—' ? value : ''; }
    function rowText(lead) { return Object.values(lead).join(' ').toLowerCase(); }
    function esc(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    }
    function todayIso() {
      return new Date().toISOString().slice(0, 10);
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
    function isOpenForOutreach(lead) {
      return !['dead', 'sent', 'replied', 'in_progress'].includes(lead.status);
    }
    function normalizedPhone(lead) {
      return String(lead.phone || '').replace(/\\D/g, '').replace(/^1/, '');
    }
    function isTollFreePhone(lead) {
      return /^(800|833|844|855|866|877|888)/.test(normalizedPhone(lead));
    }
    function inferredWebsiteStatus(lead) {
      if (lead.website_status) return lead.website_status;
      const notes = String(lead.notes || '').toLowerCase();
      if (lead.status === 'dead' && (notes.includes('website') || notes.includes('domain'))) return 'has_website';
      if (notes.includes('verified no website') || notes.includes('no official website')) return 'no_website';
      if (lead.status === 'live' || (hasDemo(lead) && notes.includes('demo deployed'))) return 'no_website';
      return 'needs_verify';
    }
    function inferredPhoneStatus(lead) {
      if (isTollFreePhone(lead)) return 'not_textable';
      return lead.phone_status || (hasPhone(lead) ? 'unverified' : 'wrong');
    }
    function inferredEmailStatus(lead) {
      return lead.email_status || (hasEmail(lead) ? 'found' : 'missing');
    }
    function inferredOwnerStatus(lead) {
      return lead.owner_status || (clean(lead.contact_name) ? 'found' : 'missing');
    }
    function outreachAction(lead) {
      if (hasEmail(lead)) return 'send_email';
      if (isTextablePhone(lead)) return 'send_sms';
      if (hasSocial(lead)) return 'send_social';
      return 'find_email';
    }
    function inferredNextAction(lead) {
      if (lead.next_action) return lead.next_action;
      if (lead.status === 'dead') return 'do_not_contact';
      if (lead.status === 'ready') return outreachAction(lead);
      if (inferredWebsiteStatus(lead) !== 'no_website') return 'verify_website';
      if (inferredPhoneStatus(lead) !== 'verified') return hasEmail(lead) ? 'send_email' : 'find_email';
      if (!hasDemo(lead)) return 'build_demo';
      if (lead.status === 'sent' || lead.status === 'replied') return 'follow_up';
      return isTextablePhone(lead) ? 'send_sms' : 'find_email';
    }
    function isTextablePhone(lead) {
      return inferredPhoneStatus(lead) === 'verified' && hasPhone(lead) && !isTollFreePhone(lead);
    }
    function readyToText(lead) {
      return isOpenForOutreach(lead) && inferredWebsiteStatus(lead) === 'no_website' && isTextablePhone(lead) && hasDemo(lead);
    }
    function readyToEmail(lead) {
      return isOpenForOutreach(lead) && inferredWebsiteStatus(lead) === 'no_website' && inferredEmailStatus(lead) !== 'bounced' && hasEmail(lead) && hasDemo(lead);
    }
    function readyToReachOut(lead) {
      if (lead.status === 'ready') return true;
      return isOpenForOutreach(lead) && inferredWebsiteStatus(lead) === 'no_website' && hasDemo(lead) && hasOutreachRoute(lead);
    }
    function needsEmail(lead) {
      return isOpenForOutreach(lead) && hasDemo(lead) && !hasEmail(lead) && !isTextablePhone(lead);
    }
    function needsFollowUp(lead) {
      return lead.status === 'sent' || inferredNextAction(lead) === 'follow_up';
    }
    function qualityScore(lead) {
      let score = 0;
      if (inferredWebsiteStatus(lead) === 'no_website') score += 35;
      if (inferredPhoneStatus(lead) === 'verified') score += 25;
      if (hasDemo(lead)) score += 15;
      if (hasEmail(lead)) score += 10;
      if (inferredOwnerStatus(lead) === 'found') score += 10;
      if (clean(lead.social)) score += 5;
      if (lead.status === 'dead') return 0;
      return score;
    }
    function researchLinks(lead) {
      const query = encodeURIComponent((lead.business || '') + ' Barrie');
      const facebook = encodeURIComponent((lead.business || '') + ' Barrie Facebook');
      const linkedIn = encodeURIComponent((lead.business || '') + ' owner LinkedIn Barrie');
      return '<div class="research-links">' +
        '<a href="https://www.google.com/search?q=' + query + '" target="_blank" rel="noopener">Google</a>' +
        '<a href="https://www.bing.com/search?q=' + query + '" target="_blank" rel="noopener">Bing</a>' +
        '<a href="https://www.google.com/search?q=' + facebook + '" target="_blank" rel="noopener">Facebook</a>' +
        '<a href="https://www.google.com/search?q=' + linkedIn + '" target="_blank" rel="noopener">LinkedIn</a>' +
        '<a href="https://www.yellowpages.ca/search/si/1/' + query + '" target="_blank" rel="noopener">YP</a>' +
      '</div>';
    }
    function firstName(name) {
      const cleanName = String(name || '').replace(/&amp;|&/g, 'and').trim();
      return cleanName.split(/\\s+/)[0] || 'there';
    }
    function shortUrl(url) {
      return String(url || '').replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
    }
    function smsTemplate(lead) {
      const demo = clean(lead.demo_url);
      return 'Hi ' + firstName(lead.contact_name || lead.business) + "! I'm Humberto. I run Kumon Mapleview here in Barrie, and I also build websites for local businesses. I noticed " + lead.business + " does not have a website yet, so I put together a quick demo: " + shortUrl(demo) + ". If you are interested, I can build you a proper professional site. Worth a look?";
    }
    function emailTemplate(lead) {
      const demo = clean(lead.demo_url);
      return 'Subject: Website demo for ' + lead.business + '\\n\\nHi ' + firstName(lead.contact_name) + ',\\n\\nMy name is Humberto. I run the Kumon Math & Reading Centre on Mapleview, and I also build websites for local Barrie businesses.\\n\\nI noticed ' + lead.business + ' does not have a website yet, so I put together a quick professional demo to show what an online presence could look like:\\n' + demo + '\\n\\nIf you are interested, I can build you a proper professional site. Worth a look?\\n\\nBest,\\nHumberto Domingues\\nhumbertobizes@gmail.com';
    }
    function fallbackCopyText(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) throw new Error('Browser blocked copy. Press Ctrl+C in the prompt.');
    }
    async function copyText(text, label) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          fallbackCopyText(text);
        }
        showToast(label + ' copied');
      } catch (error) {
        try {
          fallbackCopyText(text);
          showToast(label + ' copied');
        } catch (fallbackError) {
          window.prompt('Copy this ' + label + ' message:', text);
          showToast('Copy prompt opened');
        }
      }
    }
    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token(),
          ...(options.headers || {}),
        },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }
    async function load() {
      if (!token()) {
        leads = [];
        render();
        setMessage('Paste the admin token, then click Save token to load the tracker.');
        return;
      }
      const data = await api('/api/leads');
      leads = data.leads;
      render();
      setMessage('Loaded ' + leads.length + ' leads. Manual edits here save to Coolify storage.');
      showToast('Loaded ' + leads.length + ' leads');
    }
    function filteredLeads() {
      const query = document.getElementById('search').value.trim().toLowerCase();
      const status = document.getElementById('statusFilter').value;
      const contact = document.getElementById('contactFilter').value;
      return leads.filter((lead) => {
        if (query && !rowText(lead).includes(query)) return false;
        if (status && lead.status !== status) return false;
        if (contact === 'missing-owner' && clean(lead.contact_name)) return false;
        if (contact === 'missing-email' && clean(lead.email)) return false;
        if (contact === 'has-email' && !clean(lead.email)) return false;
        if (contact === 'phone-only' && (!clean(lead.phone) || clean(lead.email))) return false;
        if (activeView === 'ready-outreach' && !readyToReachOut(lead)) return false;
        if (activeView === 'ready-text' && !readyToText(lead)) return false;
        if (activeView === 'ready-email' && !readyToEmail(lead)) return false;
        if (activeView === 'needs-email' && !needsEmail(lead)) return false;
        if (activeView === 'needs-website' && inferredWebsiteStatus(lead) === 'no_website') return false;
        if (activeView === 'phone-unverified' && inferredPhoneStatus(lead) === 'verified') return false;
        if (activeView === 'missing-owner' && inferredOwnerStatus(lead) === 'found') return false;
        if (activeView === 'missing-email' && hasEmail(lead)) return false;
        if (activeView === 'follow-up' && !needsFollowUp(lead)) return false;
        if (activeView === 'replied' && lead.status !== 'replied') return false;
        if (activeView === 'dead' && lead.status !== 'dead') return false;
        return true;
      });
    }
    function renderStats(rows) {
      const counts = rows.reduce((acc, lead) => {
        acc[lead.status] = (acc[lead.status] || 0) + 1;
        return acc;
      }, {});
      const missingOwner = rows.filter((lead) => !clean(lead.contact_name)).length;
      const missingEmail = rows.filter((lead) => !clean(lead.email)).length;
      document.getElementById('stats').innerHTML = [
        ['Shown', rows.length],
        ['New', counts.new || 0],
        ['Ready Outreach', rows.filter(readyToReachOut).length],
        ['Sent', counts.sent || 0],
        ['Dead', counts.dead || 0],
        ['Ready Text', rows.filter(readyToText).length],
        ['Ready Email', rows.filter(readyToEmail).length],
        ['Needs Email', rows.filter(needsEmail).length],
        ['Need Site Check', rows.filter((lead) => inferredWebsiteStatus(lead) !== 'no_website' && lead.status !== 'dead').length],
        ['No Textable Phone', rows.filter((lead) => inferredPhoneStatus(lead) !== 'verified' || isTollFreePhone(lead)).length],
        ['Missing Owner', missingOwner],
        ['Missing Email', missingEmail],
      ].map(([label, value]) => '<div class="stat"><strong>' + value + '</strong><span>' + label + '</span></div>').join('');
    }
    function updateViewButtons() {
      document.querySelectorAll('[data-view]').forEach((button) => {
        button.classList.toggle('active', button.dataset.view === activeView);
      });
    }
    function render() {
      const rows = filteredLeads();
      updateViewButtons();
      renderStats(rows);
      document.getElementById('rows').innerHTML = rows.map((lead, index) => {
        const demo = clean(lead.demo_url);
        const social = clean(lead.social);
        const websiteStatus = inferredWebsiteStatus(lead);
        const phoneStatus = inferredPhoneStatus(lead);
        const emailStatus = inferredEmailStatus(lead);
        const ownerStatus = inferredOwnerStatus(lead);
        const nextAction = inferredNextAction(lead);
        return '<tr data-key="' + esc(lead.key) + '">' +
          '<td>' + (index + 1) + '<div class="tiny">' + esc(lead.date_found) + '</div></td>' +
          '<td><strong>' + esc(lead.business) + '</strong><div class="tiny">Base: ' + esc(lead.base_status) + '</div></td>' +
          '<td><span class="score">' + qualityScore(lead) + '</span></td>' +
          '<td><select class="status status-' + esc(lead.status) + '" data-field="status">' +
            ['new','ready','sent','pending','replied','dead','live','in_progress'].map((s) => '<option value="' + s + '"' + (lead.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></td>' +
          '<td><select data-field="website_status">' + ['needs_verify','no_website','unclear','has_website'].map((s) => '<option value="' + s + '"' + (websiteStatus === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><br><input class="wide-input" data-field="website_evidence" value="' + esc(clean(lead.website_evidence)) + '" placeholder="website proof / URL"></td>' +
          '<td><select data-field="phone_status">' + ['unverified','verified','not_textable','wrong','duplicate'].map((s) => '<option value="' + s + '"' + (phoneStatus === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><br><input class="cell-input" data-field="phone_source" value="' + esc(clean(lead.phone_source)) + '" placeholder="phone source"></td>' +
          '<td><input class="cell-input" data-field="contact_name" value="' + esc(clean(lead.contact_name)) + '" placeholder="Owner name"><br><select data-field="owner_status">' + ['missing','found','unclear'].map((s) => '<option value="' + s + '"' + (ownerStatus === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><br><input class="cell-input" data-field="owner_source" value="' + esc(clean(lead.owner_source)) + '" placeholder="owner source"></td>' +
          '<td><input class="cell-input" data-field="email" value="' + esc(clean(lead.email)) + '" placeholder="email"><br><select data-field="email_status">' + ['missing','found','unverified','bounced'].map((s) => '<option value="' + s + '"' + (emailStatus === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select><br><input class="cell-input" data-field="email_source" value="' + esc(clean(lead.email_source)) + '" placeholder="email source"></td>' +
          '<td>' + esc(clean(lead.phone) || '—') + '</td>' +
          '<td><input class="cell-input" data-field="social" value="' + esc(social) + '" placeholder="social URL"></td>' +
          '<td>' + esc(lead.category) + '</td>' +
          '<td>' + (demo ? '<a class="url" href="' + esc(demo) + '" target="_blank" rel="noopener">demo</a>' : 'TBD') + '</td>' +
          '<td><select data-field="next_action">' + ['research_contact','find_email','verify_website','verify_phone','build_demo','send_sms','send_email','send_social','follow_up','do_not_contact'].map((s) => '<option value="' + s + '"' + (nextAction === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></td>' +
          '<td><input type="date" data-field="follow_up_date" value="' + esc(clean(lead.follow_up_date)) + '"><br><input type="date" data-field="last_verified" value="' + esc(clean(lead.last_verified)) + '" title="Last verified"></td>' +
          '<td>' + researchLinks(lead) + '</td>' +
          '<td><textarea class="notes" data-field="notes" placeholder="verification/contact notes">' + esc(clean(lead.notes)) + '</textarea><br><input class="wide-input" data-field="dead_reason" value="' + esc(clean(lead.dead_reason)) + '" placeholder="dead reason if applicable"></td>' +
          '<td><div class="action-stack">' +
            (isTextablePhone(lead) && demo ? '<button class="copy-sms" data-copy="sms" data-key="' + esc(lead.key) + '">Copy SMS</button> ' : '') +
            (clean(lead.email) && demo ? '<button class="copy-email" data-copy="email" data-key="' + esc(lead.key) + '">Copy Email</button> ' : '') +
            (isTextablePhone(lead) && demo ? '<button class="quick-sent" data-action="sms-sent" data-key="' + esc(lead.key) + '">Mark SMS Sent</button> ' : '') +
            (clean(lead.email) && demo ? '<button class="quick-sent" data-action="email-sent" data-key="' + esc(lead.key) + '">Mark Email Sent</button> ' : '') +
            (demo && readyToReachOut(lead) ? '<button class="save-btn" data-action="ready" data-key="' + esc(lead.key) + '">Mark Ready</button> ' : '') +
            '<button class="quick-replied" data-action="replied" data-key="' + esc(lead.key) + '">Replied</button> ' +
            '<button class="quick-dead" data-action="dead" data-key="' + esc(lead.key) + '">Dead</button> ' +
            '<button class="save-btn" data-save="' + esc(lead.key) + '">Save</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }
    async function saveRow(button) {
      const tr = button.closest('tr');
      const lead = leads.find((item) => item.key === tr.dataset.key);
      const payload = { key: tr.dataset.key, business: lead.business };
      tr.querySelectorAll('[data-field]').forEach((field) => {
        payload[field.dataset.field] = field.value;
      });
      const result = await api('/api/lead', { method: 'POST', body: JSON.stringify(payload) });
      Object.assign(lead, result.override);
      render();
      showToast('Saved ' + lead.business);
    }
    async function quickAction(button) {
      const lead = leads.find((item) => item.key === button.dataset.key);
      const action = button.dataset.action;
      const payload = { key: lead.key, business: lead.business };

      if (action === 'sms-sent') {
        Object.assign(payload, {
          status: 'sent',
          outreach_method: 'sms',
          outreach_date: todayIso(),
          next_action: 'follow_up',
          follow_up_date: lead.follow_up_date || '',
          notes: (clean(lead.notes) || '') + '\\nSent SMS on ' + todayIso() + '.',
        });
      }
      if (action === 'email-sent') {
        Object.assign(payload, {
          status: 'sent',
          outreach_method: 'email',
          outreach_date: todayIso(),
          next_action: 'follow_up',
          follow_up_date: lead.follow_up_date || '',
          notes: (clean(lead.notes) || '') + '\\nSent email on ' + todayIso() + '.',
        });
      }
      if (action === 'replied') {
        Object.assign(payload, { status: 'replied', next_action: 'follow_up' });
      }
      if (action === 'ready') {
        Object.assign(payload, {
          status: 'ready',
          next_action: outreachAction(lead),
          notes: (clean(lead.notes) || '') + '\\nMarked ready for outreach on ' + todayIso() + '.',
        });
      }
      if (action === 'dead') {
        const reason = prompt('Why is this lead dead? If they have a website, paste the website/domain.');
        if (!reason) return;
        Object.assign(payload, {
          status: 'dead',
          website_status: reason.includes('.') ? 'has_website' : (lead.website_status || 'unclear'),
          website_evidence: reason.includes('.') ? reason : (lead.website_evidence || ''),
          dead_reason: reason,
          next_action: 'do_not_contact',
          notes: (clean(lead.notes) || '') + '\\nDead: ' + reason,
        });
      }

      const result = await api('/api/lead', { method: 'POST', body: JSON.stringify(payload) });
      Object.assign(lead, result.override);
      render();
      showToast('Updated ' + lead.business);
    }
    document.addEventListener('click', (event) => {
      if (event.target.id === 'reload') load().catch((error) => showToast(error.message));
      if (event.target.dataset.save) saveRow(event.target).catch((error) => showToast(error.message));
      if (event.target.dataset.action) quickAction(event.target).catch((error) => showToast(error.message));
      if (event.target.dataset.view !== undefined) {
        activeView = event.target.dataset.view;
        render();
      }
      const copyButton = event.target.closest('[data-copy]');
      if (copyButton) {
        const lead = leads.find((item) => item.key === copyButton.dataset.key);
        if (!lead) {
          showToast('Lead not found. Click Reload and try again.');
          return;
        }
        const text = copyButton.dataset.copy === 'sms' ? smsTemplate(lead) : emailTemplate(lead);
        copyText(text, copyButton.dataset.copy.toUpperCase()).catch((error) => showToast(error.message));
      }
    });
    document.getElementById('tokenForm').addEventListener('submit', (event) => {
      event.preventDefault();
      localStorage.setItem('barrie_admin_token', token());
      showToast('Token saved');
      load().catch((error) => {
        setMessage(error.message);
        showToast(error.message);
      });
    });
    ['search', 'statusFilter', 'contactFilter'].forEach((id) => {
      document.getElementById(id).addEventListener('input', render);
    });
    load().catch((error) => {
      setMessage(error.message);
      showToast(error.message);
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/leads') {
      if (!requireAuth(req, res)) return;
      sendJson(res, 200, { leads: await loadLeads() });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/lead') {
      if (!requireAuth(req, res)) return;
      const payload = JSON.parse(await readBody(req));
      sendJson(res, 200, upsertOverride(payload));
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Barrie tracker admin listening on ${PORT}`);
});
