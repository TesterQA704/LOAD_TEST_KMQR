/**
 * Replika lokal KMQR (Blazor Server + MudBlazor) untuk menguji flows.js tanpa akses ke server asli.
 * Meniru perilaku yang relevan:
 *  - setiap event UI = POST /_blazor berisi "BeginInvokeDotNetFromJS"; DOM baru berubah setelah server menjawab
 *  - kiriman diserialkan (1 POST sekaligus) seperti SignalR Long Polling
 *  - toggle grup sidebar = TOGGLE di server (2 klik saling membatalkan)
 *  - dropdown MudSelect: overlay menutupi halaman sampai server menutup dropdown
 * Env: LAT_MIN/LAT_MAX (ms latency per event), ACCORDION=1, IGNORE_RATE (0..1 klik toggle diabaikan), PORT
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = +(process.env.PORT || 8443);
const LAT_MIN = +(process.env.LAT_MIN || 100);
const LAT_MAX = +(process.env.LAT_MAX || 1500);
const stats = { events: 0, toggles: 0 };

const CLIENT = `
const CFG = { accordion: ${process.env.ACCORDION === '1'}, ignoreRate: ${+(process.env.IGNORE_RATE || 0)} };
// ---- "SignalR Long Polling" (TransportSendQueue): 1 POST sekaligus; event yang tertahan selama POST berjalan
// dikirim bersama dalam 1 POST berikutnya, dan server me-render hasil bersihnya dalam 1 render batch ----
let inflight = false;
let buffer = [];
function send(name, apply) {
  buffer.push({ name, apply });
  if (!inflight) flush();
}
function flush() {
  if (!buffer.length) { inflight = false; return; }
  inflight = true;
  const batch = buffer; buffer = [];
  fetch('/_blazor?id=x', { method: 'POST', body: batch.map((b) => 'BeginInvokeDotNetFromJS ' + b.name).join('\\x1e') })
    .then((r) => r.text()).then(() => { for (const b of batch) b.apply && b.apply(); flush(); });
}
const $ = (s, r = document) => r.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const loggedIn = () => sessionStorage.getItem('auth') === '1';

const MODULES = {
  '/MetricsDetail/MetricsTargetCorp': ['Metrics Target - Corporate', 'target'],
  '/MetricsDetail/MetricsTargetSite': ['Metrics Target - Site', 'target'],
  '/MetricsDetail/MetricsTargetApproval': ['Metrics Target - Approval', 'target'],
  '/MetricsDetail/MetricsResultInput': ['Metrics Result - Input', 'result'],
  '/MetricsDetail/MetricsResultReview': ['Metrics Result - Review', 'result'],
  '/Dashboard/PicapaSira': ['PICAPA/SIRA'],
  '/Dashboard/AuditTrail': ['Audit Trail'],
  '/Dashboard/DocumentList': ['Document List'],
};
const GROUPS = {
  'Metrics Detail': [['Metrics Target Corporate', '/MetricsDetail/MetricsTargetCorp'], ['Metrics Target Site', '/MetricsDetail/MetricsTargetSite'],
    ['Metrics Target Approval', '/MetricsDetail/MetricsTargetApproval'], ['Metrics Result Input', '/MetricsDetail/MetricsResultInput'],
    ['Metrics Result Review', '/MetricsDetail/MetricsResultReview']],
  'Dashboard Reporting': [['Metrics Summary', '/Dashboard/MetricsSummary'], ['Picapa Sira', '/Dashboard/PicapaSira'],
    ['Audit Trail', '/Dashboard/AuditTrail'], ['Document List', '/Dashboard/DocumentList']],
  'Metrics Setup': [['Setup', '/Setup']],
};

function loginPage() {
  document.body.innerHTML = '';
  const render = () => {
    document.body.innerHTML = \`<div class="card"><p>(Kalbe/Key Metrics - Manufacturing, Quality, Regulatory)</p>
      <label for="u">Username*</label><input id="u" type="text"><label for="p">Password*</label><input id="p" type="password">
      <button id="signin"><span>Sign In</span></button><div id="msg"></div></div>\`;
  };
  render();
  // Circuit Blazor siap setelah jeda: form di-render ulang (isian hilang), baru handler klik terpasang
  setTimeout(() => {
    render();
    $('#signin').addEventListener('click', () => {
      const u = $('#u').value, p = $('#p').value;
      send('login', () => {
        if (u === 'mock.user@example.com' && p === 'mock-pass') { sessionStorage.setItem('auth', '1'); location.href = '/'; }
        else $('#msg').textContent = 'Username or Password is invalid';
      });
    });
  }, 300 + Math.random() * 900);
}

function layout() {
  document.body.innerHTML = \`<div class="mud-avatar"><button id="avatar">U</button></div><div id="usermenu"></div>
    <nav id="nav"></nav><main id="main"></main><div class="mud-popover-provider" id="pp"></div><div id="snack"></div>\`;
  for (const [title, links] of Object.entries(GROUPS)) {
    const g = h(\`<div class="group"><button aria-label="Toggle \${title}" aria-expanded="false">\${title}</button>
      <div class="mud-collapse" aria-hidden="true" style="display:none"></div></div>\`);
    const box = $('.mud-collapse', g);
    for (const [name, href] of links) {
      const a = h(\`<a href="\${href}">\${name}</a>\`);
      a.addEventListener('click', (e) => { e.preventDefault(); history.pushState(null, '', href); route(); });
      box.append(a);
    }
    const btn = $('button', g);
    btn.addEventListener('click', () => {
      if (Math.random() < CFG.ignoreRate) return; // handler belum siap: klik tidak terkirim
      send('toggle', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        if (CFG.accordion && open) document.querySelectorAll('#nav .group').forEach((o) => setGroup(o, false));
        setGroup(g, open);
        fetch('/_stats?toggle=1');
      });
    });
    $('#nav').append(g);
  }
  $('#avatar').addEventListener('click', () => {
    $('#usermenu').innerHTML = '<div class="mud-menu-item">Logout</div>';
    $('#usermenu .mud-menu-item').addEventListener('click', () => send('logout', () => { sessionStorage.clear(); location.href = '/Auth/Login'; }));
  });
}
function setGroup(g, open) {
  const btn = $('button', g), box = $('.mud-collapse', g);
  btn.setAttribute('aria-expanded', String(open));
  box.setAttribute('aria-hidden', String(!open));
  box.style.display = open ? 'block' : 'none';
}

function select(label, options) {
  const c = h(\`<div class="mud-input-control"><label>\${label}</label><div class="value"></div></div>\`);
  c.addEventListener('click', () => send('open-select', () => {
    const pp = $('#pp');
    pp.innerHTML = '<div class="mud-overlay"></div><div class="mud-popover mud-popover-open"><div class="mud-list"></div></div>';
    for (const o of options()) {
      const item = h(\`<div class="mud-list-item">\${o}</div>\`);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        send('choose', () => { $('.value', c).textContent = o; pp.innerHTML = ''; });
      });
      $('.mud-list', pp).append(item);
    }
  }));
  return c;
}

function modulePage(path) {
  const [heading, filters] = MODULES[path] || ['Job/Tasks'];
  const main = $('#main');
  main.innerHTML = '<div class="mud-progress-linear"></div>';
  send('navigate', () => {
    if (location.pathname !== path) return;
    main.innerHTML = \`<h5>\${heading}</h5><div id="filters"></div>\`;
    if (filters) {
      const f = $('#filters');
      const val = (l) => [...document.querySelectorAll('.mud-input-control')].find((c) => $('label', c).textContent === l)?.querySelector('.value').textContent;
      f.append(select('Year', () => ['2026', '2027']), select('SBU', () => ['TEST', 'Tests']),
        select('Site', () => (val('SBU') ? ['test', 'FinalTest'] : [])));
      if (filters === 'result') f.append(select('Month', () => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']));
      f.append(select('Type', () => ['Quality', 'Manufacture']));
      const btn = h('<button>REFRESH</button>');
      btn.addEventListener('click', () => {
        const missing = ['Year', 'SBU', 'Site', 'Type'].filter((l) => !val(l));
        $('#tbl').innerHTML = '<div class="mud-table-loading"></div><table><tbody></tbody></table>';
        send('refresh', () => {
          if (missing.length) { $('#tbl').innerHTML = ''; $('#snack').innerHTML = '<div class="mud-snackbar">Please select ' + missing[0] + '</div>'; return; }
          $('#tbl').innerHTML = '<table><tbody><tr><td>row 1</td></tr><tr><td>row 2</td></tr></tbody></table>';
        });
      });
      f.append(btn);
      main.append(h('<div class="mud-table" id="tbl"></div>'));
    }
  });
}

function route() {
  const p = location.pathname;
  if (p.startsWith('/Auth/Login')) return loggedIn() ? (location.href = '/') : loginPage();
  if (!loggedIn()) { setTimeout(() => location.replace('/Auth/Login'), 150); return; }
  if (!$('#nav')) layout();
  modulePage(p);
}
window.addEventListener('popstate', route);
route();
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>KMQR mock</title>
<style>.mud-overlay{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.05)}.mud-popover-open{position:fixed;top:40px;left:40%;z-index:11;background:#fff;border:1px solid #888}
.mud-list-item{padding:4px 12px;cursor:pointer}.mud-input-control{display:inline-block;border:1px solid #aaa;margin:4px;padding:4px;min-width:90px;cursor:pointer}
nav{float:left;width:220px}nav a{display:block;padding:3px 16px}main{margin-left:230px}input{display:block}</style></head>
<body><script>${CLIENT}</script></body></html>`;

const delay = () => LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN);
https.createServer({ key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem')) }, (req, res) => {
  if (req.url.startsWith('/_stats')) {
    if (req.url.includes('toggle')) stats.toggles++;
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url.startsWith('/_blazor')) {
    stats.events++;
    req.resume();
    setTimeout(() => res.end('ok'), delay());
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
}).listen(PORT, '127.0.0.1', () => console.log(`mock KMQR on https://127.0.0.1:${PORT} latency ${LAT_MIN}-${LAT_MAX}ms accordion=${process.env.ACCORDION === '1'} ignoreRate=${process.env.IGNORE_RATE || 0}`));
