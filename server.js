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

const STATUS_VALUES = new Set(['new', 'sent', 'pending', 'replied', 'dead', 'live', 'in_progress']);

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

  ['contact_name', 'email', 'social', 'notes', 'outreach_method', 'outreach_date'].forEach((field) => {
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
    .message { background: #1a1d2a; border: 1px solid #2a2d3a; border-radius: 8px; color: #d7c176; margin-bottom: 14px; padding: 10px 12px; }
    input, select, textarea, button { border: 1px solid #2a2d3a; border-radius: 6px; background: #161923; color: #eee; padding: 7px 9px; }
    button { cursor: pointer; background: #2a2413; color: #e4c66f; font-weight: 700; }
    button:hover { filter: brightness(1.15); }
    .copy-sms { background: #17314f; color: #8fc5ff; }
    .copy-email { background: #321d54; color: #d5b2ff; }
    .save-btn { background: #2a2413; color: #e4c66f; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .stat { background: #1a1d2a; border-radius: 8px; padding: 10px 14px; min-width: 110px; }
    .stat strong { color: #c9a84c; display: block; font-size: 1.25rem; }
    .wrap { overflow-x: auto; border: 1px solid #1f2330; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 1350px; font-size: 0.82rem; }
    th, td { border-bottom: 1px solid #1f2330; padding: 8px; vertical-align: top; text-align: left; }
    th { color: #c9a84c; background: #171a25; position: sticky; top: 0; }
    .url { color: #70a7ff; word-break: break-all; }
    .tiny { color: #777; font-size: 0.72rem; }
    .status-new { color: #4ade80; }
    .status-sent { color: #60a5fa; }
    .status-dead { color: #ef7777; }
    .status-pending { color: #fbbf24; }
    .status-live { color: #4ade80; }
    .cell-input { width: 180px; }
    .notes { width: 260px; min-height: 38px; }
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
  <div id="stats" class="stats"></div>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>#</th><th>Business</th><th>Status</th><th>Owner / Contact</th><th>Email</th><th>Phone</th>
          <th>Social</th><th>Category</th><th>Demo URL</th><th>Notes</th><th>Action</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    let leads = [];
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
    function firstName(name) {
      const cleanName = String(name || '').replace(/&amp;|&/g, 'and').trim();
      return cleanName.split(/\\s+/)[0] || 'there';
    }
    function shortUrl(url) {
      return String(url || '').replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
    }
    function smsTemplate(lead) {
      const demo = clean(lead.demo_url);
      return 'Hi ' + firstName(lead.contact_name || lead.business) + "! I'm Humberto, a local Barrie business owner (Kumon Mapleview). I noticed " + lead.business + " does not have a website yet. I put together a quick demo: " + shortUrl(demo) + ". If you are interested, I can build you a proper professional site. No pressure. Worth a look?";
    }
    function emailTemplate(lead) {
      const demo = clean(lead.demo_url);
      return 'Subject: Website demo for ' + lead.business + '\\n\\nHi ' + firstName(lead.contact_name) + ',\\n\\nMy name is Humberto. I run the Kumon Math & Reading Centre on Mapleview and also build websites for local Barrie businesses.\\n\\nI noticed ' + lead.business + ' does not have a website yet, so I put together a quick professional demo to show what an online presence could look like:\\n' + demo + '\\n\\nIf you are interested, I can build you a proper professional site. No pressure. Worth a look?\\n\\nBest,\\nHumberto Domingues\\nhumbertobizes@gmail.com';
    }
    async function copyText(text, label) {
      await navigator.clipboard.writeText(text);
      showToast(label + ' copied');
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
        ['Sent', counts.sent || 0],
        ['Dead', counts.dead || 0],
        ['Missing Owner', missingOwner],
        ['Missing Email', missingEmail],
      ].map(([label, value]) => '<div class="stat"><strong>' + value + '</strong><span>' + label + '</span></div>').join('');
    }
    function render() {
      const rows = filteredLeads();
      renderStats(rows);
      document.getElementById('rows').innerHTML = rows.map((lead, index) => {
        const demo = clean(lead.demo_url);
        const social = clean(lead.social);
        return '<tr data-key="' + esc(lead.key) + '">' +
          '<td>' + (index + 1) + '<div class="tiny">' + esc(lead.date_found) + '</div></td>' +
          '<td><strong>' + esc(lead.business) + '</strong><div class="tiny">Base: ' + esc(lead.base_status) + '</div></td>' +
          '<td><select class="status status-' + esc(lead.status) + '" data-field="status">' +
            ['new','sent','pending','replied','dead','live','in_progress'].map((s) => '<option value="' + s + '"' + (lead.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
          '</select></td>' +
          '<td><input class="cell-input" data-field="contact_name" value="' + esc(clean(lead.contact_name)) + '" placeholder="Owner name"></td>' +
          '<td><input class="cell-input" data-field="email" value="' + esc(clean(lead.email)) + '" placeholder="email"></td>' +
          '<td>' + esc(clean(lead.phone) || '—') + '</td>' +
          '<td><input class="cell-input" data-field="social" value="' + esc(social) + '" placeholder="social URL"></td>' +
          '<td>' + esc(lead.category) + '</td>' +
          '<td>' + (demo ? '<a class="url" href="' + esc(demo) + '" target="_blank" rel="noopener">demo</a>' : 'TBD') + '</td>' +
          '<td><textarea class="notes" data-field="notes" placeholder="verification/contact notes">' + esc(clean(lead.notes)) + '</textarea></td>' +
          '<td>' +
            (clean(lead.phone) && demo ? '<button class="copy-sms" data-copy="sms" data-key="' + esc(lead.key) + '">SMS</button> ' : '') +
            (clean(lead.email) && demo ? '<button class="copy-email" data-copy="email" data-key="' + esc(lead.key) + '">Email</button> ' : '') +
            '<button class="save-btn" data-save="' + esc(lead.key) + '">Save</button>' +
          '</td>' +
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
    document.addEventListener('click', (event) => {
      if (event.target.id === 'reload') load().catch((error) => showToast(error.message));
      if (event.target.dataset.save) saveRow(event.target).catch((error) => showToast(error.message));
      if (event.target.dataset.copy) {
        const lead = leads.find((item) => item.key === event.target.dataset.key);
        const text = event.target.dataset.copy === 'sms' ? smsTemplate(lead) : emailTemplate(lead);
        copyText(text, event.target.dataset.copy.toUpperCase()).catch((error) => showToast(error.message));
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
