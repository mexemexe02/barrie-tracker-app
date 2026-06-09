const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  mergeStatus,
  mergeLead,
  alreadyContacted,
  readyToReachOut,
  needsFollowUp,
  canUsePhoneForOutreach,
} = require('./lead-logic');

const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
for (const file of ['server.js', 'lead-logic.js']) {
  assert.match(dockerfile, new RegExp(file), `Dockerfile must COPY ${file}`);
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

assert.strictEqual(mergeStatus('sent', 'ready'), 'sent');
assert.strictEqual(mergeStatus('ready', 'sent'), 'sent');
assert.strictEqual(mergeStatus('new', ''), 'new');

assert.strictEqual(
  alreadyContacted({ status: 'new', outreach_date: '', outreach_method: '' }),
  false,
);
assert.strictEqual(
  alreadyContacted({ status: 'sent', outreach_date: '', outreach_method: '' }),
  true,
);

const merged = mergeLead(
  { business: 'Test Co', status: 'sent', outreach_method: 'sms', outreach_date: '2026-06-05' },
  { status: 'ready', outreach_method: '', outreach_date: '' },
);
assert.strictEqual(merged.status, 'sent');
assert.strictEqual(merged.outreach_method, 'sms');
assert.strictEqual(merged.outreach_date, '2026-06-05');

const csvPath = path.join(__dirname, '..', 'leads.csv');
const leads = parseCsv(fs.readFileSync(csvPath, 'utf8')).map((lead) => mergeLead(lead, {}));

const sent = leads.filter((lead) => lead.status === 'sent');
const ready = leads.filter((lead) => readyToReachOut(lead));
const followUp = leads.filter((lead) => needsFollowUp(lead));
const overlap = ready.filter((lead) => alreadyContacted(lead));

assert.ok(sent.length >= 20, `expected many sent leads, got ${sent.length}`);
assert.strictEqual(overlap.length, 0, 'sent/contacted leads must not appear in ready outreach');
assert.ok(followUp.length >= sent.length, 'follow-up should include all sent leads');

console.log('audit-logic.test.js OK');
console.log(`  sent=${sent.length} ready=${ready.length} follow-up=${followUp.length}`);
