/**
 * Membuat report HTML (offline, satu file) dari JSON hasil Artillery.
 * Pengganti "artillery report" yang sudah tidak didukung di Artillery 2.x.
 *
 * Pemakaian:
 *   node report.js                         -> pakai JSON terbaru di results/
 *   node report.js results/xxx.json        -> pakai file tertentu
 * Output: file .html dengan nama sama di sebelah JSON-nya.
 */
const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');

function latestJson() {
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(RESULTS_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('Tidak ada file JSON di results/. Jalankan test dengan -o results dulu.');
  return files[0];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms = (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const fmtTime = (t) => new Date(t).toLocaleString('id-ID', { hour12: false });

const fmtClock = (t) => new Date(t).toLocaleTimeString('id-ID', { hour12: false });
const fmtOffset = (msSinceStart) => {
  const sec = Math.max(0, Math.round(msSinceStart / 1000));
  return `+${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};
const SCREENSHOT_DIR = path.join(RESULTS_DIR, 'screenshots');

/**
 * Baca info tambahan dari file .log (output mentah Artillery, dibuat run.js) di sebelah JSON:
 * jadwal phase dan hasil checks. Jam di log hanya HH:MM:SS, tanggalnya diambil dari awal test.
 */
function readRunLog(jsonFile, firstMetricAt) {
  const logFile = jsonFile.replace(/\.json$/i, '.log');
  const out = { phases: [], checks: [], journeyFailures: [], hasLog: fs.existsSync(logFile) };
  if (!out.hasLog) return out;
  const base = new Date(firstMetricAt);
  const toTime = (hh, mm, ss) => {
    const d = new Date(base);
    d.setHours(+hh, +mm, +ss, 0);
    if (d.getTime() < firstMetricAt - 12 * 3600 * 1000) d.setDate(d.getDate() + 1); // lewat tengah malam
    return d.getTime();
  };
  for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
    let m = line.match(/Phase started: (.+?) \(index: (\d+), duration: (\d+)s\) (\d\d):(\d\d):(\d\d)/);
    if (m) out.phases.push({ name: m[1], start: toTime(m[4], m[5], m[6]), end: toTime(m[4], m[5], m[6]) + Number(m[3]) * 1000 });
    m = line.match(/^\s*(ok|fail): (.+)$/);
    if (m) out.checks.push({ ok: m[1] === 'ok', text: m[2].trim() });
    m = line.match(/^\[JOURNEY_FAILED\] (?:time=(\S+) )?vu=(\S+) user=(\S+) step=(\S+) error=(.*?)(?: cause=(.*))?$/);
    if (m) out.journeyFailures.push({ time: m[1] ? Date.parse(m[1]) : null, vu: m[2], user: m[3], step: m[4], error: m[5], cause: m[6] || null });
  }
  return out;
}

/**
 * Daftar VU yang gagal. Sumber utama: <nama>.failures.jsonl (ditulis flows.js).
 * Untuk run lama tanpa file itu: baris [JOURNEY_FAILED] di .log + jam dari nama file screenshot.
 */
function readFailures(jsonFile, runLog) {
  const jsonl = jsonFile.replace(/\.json$/i, '.failures.jsonl');
  if (fs.existsSync(jsonl)) {
    return fs.readFileSync(jsonl, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.time - b.time);
  }
  const shots = fs.existsSync(SCREENSHOT_DIR) ? fs.readdirSync(SCREENSHOT_DIR) : [];
  return runLog.journeyFailures.map((f) => {
    const shot = shots.find((n) => n.includes(`-${f.vu}-${f.step}.png`));
    const shotTime = shot ? Number(shot.split('-')[0]) : null;
    return { ...f, time: f.time || shotTime, screenshot: shot || null };
  }).filter((f) => f.time).sort((a, b) => a.time - b.time);
}

/** Kondisi laptop & probe server tiap 5 detik (<nama>.client.jsonl, ditulis run.js). null kalau run lama. */
function readClient(jsonFile) {
  const file = jsonFile.replace(/\.json$/i, '.client.jsonl');
  if (!fs.existsSync(file)) return null;
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return rows.length ? rows : null;
}

// Batas "laptop kewalahan": di atas ini hasil test bisa terdistorsi oleh laptop, bukan server
const CLIENT_LIMITS = { cpu: 90, freeMb: 700, lagMs: 1000 };
// Error browser yang berarti laptop tidak bisa mencapai server sama sekali (DNS/jaringan/VPN)
const BROWSER_NET_ERR = /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/;
const median = (arr) => {
  if (!arr.length) return null;
  const v = [...arr].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};

/** Line chart SVG sederhana. series = [{ name, color, points: [[x, y], ...] }], overlay = { phases, failures } */
function lineChart(title, series, yFmt = (v) => +v.toFixed(1), overlay = {}) {
  const W = 640, H = 220, L = 56, R = 12, T = 12, B = 28;
  const all = series.flatMap((s) => s.points);
  if (!all.length) return `<figure class="chart"><figcaption>${esc(title)}</figcaption><p class="muted">Tidak ada data</p></figure>`;
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const y1 = Math.max(1, ...all.map((p) => p[1])) * 1.1;
  const sx = (x) => L + ((x - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const sy = (y) => H - B - (y / y1) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = sy(y1 * f);
    return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="grid"/><text x="${L - 6}" y="${y + 4}" class="tick" text-anchor="end">${esc(yFmt(y1 * f))}</text>`;
  }).join('');
  const xTicks = [0, 0.5, 1].map((f) => {
    const x = x0 + (x1 - x0) * f;
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle';
    return `<text x="${sx(x)}" y="${H - 8}" class="tick" text-anchor="${anchor}">${new Date(x).toLocaleTimeString('id-ID', { hour12: false })}</text>`;
  }).join('');
  const lines = series.map((s) => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
    const dots = s.points.length < 60 ? s.points.map((p) => `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="2.5" fill="${s.color}"/>`).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots}`;
  }).join('');
  const legend = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  // Batas phase: garis putus-putus + nama phase di atas
  const phaseMarks = (overlay.phases || []).filter((p) => p.start < x1 && p.end > x0).map((p) => {
    const x = sx(Math.max(p.start, x0));
    const line = p.start > x0 ? `<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" class="phase-line"/>` : '';
    return `${line}<text x="${x + 4}" y="${T + 9}" class="phase-label">${esc(p.name)}</text>`;
  }).join('');
  // VU gagal: segitiga merah di sumbu bawah
  const failures = (overlay.failures || []).filter((f) => f.time >= x0 && f.time <= x1 + 10000);
  const failMarks = failures.map((f) => {
    const x = sx(Math.min(f.time, x1)).toFixed(1);
    const y = H - B;
    return `<path d="M${x - 4},${y} L${+x + 4},${y} L${x},${y - 8} Z" class="fail-mark"/>`;
  }).join('');
  // Data untuk tooltip hover: [posisi x, posisi y, timestamp, nilai terformat] per titik
  const hoverData = {
    series: series.filter((s) => s.points.length).map((s) => ({
      name: s.name,
      color: s.color,
      pts: s.points.map((p) => [+sx(p[0]).toFixed(1), +sy(p[1]).toFixed(1), Number(p[0]), String(yFmt(p[1]))]),
    })),
    fails: failures.map((f) => [f.time, `${fmtClock(f.time)} ${f.step}`]),
  };
  const hover = `<line class="hover-line" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/><g class="hover-dots"></g>`
    + `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  const failLegend = failures.length ? '<span><i class="fail-legend"></i>VU gagal</span>' : '';
  return `<figure class="chart" data-chart="${esc(JSON.stringify(hoverData))}"><figcaption>${esc(title)}</figcaption><div class="legend">${legend}${failLegend}</div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${xTicks}${phaseMarks}${lines}${failMarks}${hover}</svg><div class="tip"></div></figure>`;
}

// Tooltip hover grafik: garis vertikal di titik waktu terdekat + nilai semua seri pada waktu itu
const HOVER_SCRIPT = `
document.querySelectorAll('figure.chart[data-chart]').forEach(function (fig) {
  var data = JSON.parse(fig.dataset.chart);
  var svg = fig.querySelector('svg'), tip = fig.querySelector('.tip');
  var vline = svg.querySelector('.hover-line'), dots = svg.querySelector('.hover-dots');
  var xs = [];
  data.series.forEach(function (s) { s.pts.forEach(function (p) { if (xs.indexOf(p[0]) < 0) xs.push(p[0]); }); });
  if (!xs.length) return;
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  function show(evt) {
    var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    var loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    var best = xs.reduce(function (a, x) { return Math.abs(x - loc.x) < Math.abs(a - loc.x) ? x : a; }, xs[0]);
    var hits = [];
    data.series.forEach(function (s) { s.pts.forEach(function (p) { if (p[0] === best) hits.push({ s: s, p: p }); }); });
    vline.setAttribute('x1', best); vline.setAttribute('x2', best); vline.style.display = '';
    dots.innerHTML = hits.map(function (h) { return '<circle cx="' + h.p[0] + '" cy="' + h.p[1] + '" r="5" fill="' + h.s.color + '" class="hover-dot"/>'; }).join('');
    // VU gagal di periode 10 detik yang di-hover
    var ts = hits[0].p[2];
    var fails = (data.fails || []).filter(function (f) { return f[0] >= ts && f[0] < ts + 10000; });
    tip.innerHTML = '<div class="tip-time">' + new Date(ts).toLocaleTimeString('id-ID', { hour12: false }) + '</div>'
      + hits.map(function (h) { return '<div class="tip-row"><i style="background:' + h.s.color + '"></i>' + esc(h.s.name) + '<b>' + esc(h.p[3]) + '</b></div>'; }).join('')
      + fails.map(function (f) { return '<div class="tip-row tip-fail"><i class="fail-legend"></i>VU gagal<b>' + esc(f[1]) + '</b></div>'; }).join('');
    tip.style.display = 'block';
    var svgRect = svg.getBoundingClientRect(), figRect = fig.getBoundingClientRect();
    var scale = svgRect.width / svg.viewBox.baseVal.width;
    var x = svgRect.left - figRect.left + best * scale;
    var left = x + 14;
    if (left + tip.offsetWidth > fig.clientWidth - 4) left = x - tip.offsetWidth - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = (svgRect.top - figRect.top + 6) + 'px';
  }
  function hide() { vline.style.display = 'none'; dots.innerHTML = ''; tip.style.display = 'none'; }
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
});`;

function build(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const agg = data.aggregate;
  const inter = (data.intermediate || []).filter((p) => p.period).sort((a, b) => a.period - b.period);
  const c = agg.counters || {};
  const s = agg.summaries || {};

  const created = c['vusers.created'] || 0;
  const completed = c['vusers.completed'] || 0;
  const failed = c['vusers.failed'] || 0;
  const errorRate = created ? (failed / created) * 100 : 0;
  const durationS = Math.round((agg.lastMetricAt - agg.firstMetricAt) / 1000);

  const tiles = [
    ['VU dibuat', created],
    ['VU selesai', completed],
    ['VU gagal', failed, failed > 0 ? 'bad' : 'good'],
    ['Error rate', `${errorRate.toFixed(1)}%`, errorRate > 0 ? 'bad' : 'good'],
    ['Retry login', c['kmqr.login_retry'] || 0, c['kmqr.login_retry'] ? 'warn' : ''],
    ['Logout gagal', c['kmqr.logout_failed'] || 0, c['kmqr.logout_failed'] ? 'warn' : ''],
    ['HTTP request', c['browser.http_requests'] || 0],
    ['Durasi test', `${Math.floor(durationS / 60)}m ${durationS % 60}s`],
  ].map(([label, val, cls = '']) => `<div class="tile ${cls}"><div class="label">${label}</div><div class="val">${val}</div></div>`).join('');

  const statRow = (key, label) => {
    const m = s[key];
    if (!m) return '';
    return `<tr><td>${esc(label)}</td><td>${m.count}</td><td>${ms(m.min)}</td><td>${ms(m.median)}</td><td>${ms(m.p90)}</td><td><b>${ms(m.p95)}</b></td><td>${ms(m.p99)}</td><td>${ms(m.max)}</td></tr>`;
  };
  const stepKeys = Object.keys(s).filter((k) => k.startsWith('browser.step.')).sort();
  const stepRows = [
    ...stepKeys.map((k) => statRow(k, k.replace('browser.step.', ''))),
    statRow('kmqr.login', 'login: klik → menu tampil (kmqr.login)'),
    statRow('kmqr.module_load', 'semua modul (kmqr.module_load)'),
    statRow('kmqr.metrics_refresh', 'semua refresh metrics (kmqr.metrics_refresh)'),
    statRow('vusers.session_length', 'durasi 1 sesi (vusers.session_length)'),
  ].join('');
  const vitalRows = Object.keys(s).filter((k) => k.startsWith('browser.page.') && !k.includes('CLS')).sort()
    .map((k) => statRow(k, k.replace('browser.page.', '').replace(/\.kmqr-user-journey$/, ''))).join('');

  const problems = Object.entries(c)
    .filter(([k]) => k.startsWith('errors.') || k.startsWith('kmqr.failed_step.') || ['kmqr.logout_failed', 'kmqr.login_retry', 'kmqr.login_form_reset', 'kmqr.skipped_low_ram', 'kmqr.circuit_terminated', 'vusers.skipped'].includes(k))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('');

  const COLORS = ['#2a78d6', '#1baf7a', '#e8833a', '#9b5de5', '#d64545', '#7a8a99'];
  const series = (metric, field) => inter.filter((p) => p.summaries && p.summaries[metric]).map((p) => [p.period, p.summaries[metric][field]]);
  // VU aktif = total dibuat - total selesai/gagal sampai akhir periode tersebut
  let active = 0, failedTotal = 0;
  const activeSeries = [], failedSeries = [];
  for (const p of inter) {
    const pc = p.counters || {};
    active += (pc['vusers.created'] || 0) - (pc['vusers.completed'] || 0) - (pc['vusers.failed'] || 0);
    failedTotal += pc['vusers.failed'] || 0;
    activeSeries.push([p.period, active]);
    failedSeries.push([p.period, failedTotal]);
  }

  const runLog = readRunLog(file, agg.firstMetricAt);
  const failures = readFailures(file, runLog);
  const overlay = { phases: runLog.phases, failures };

  const charts = [
    lineChart('VU aktif bersamaan', [
      { name: 'VU aktif', color: COLORS[0], points: activeSeries },
      { name: 'total VU gagal', color: COLORS[4], points: failedSeries },
    ], undefined, overlay),
    lineChart('p95 waktu respons per periode', [
      { name: 'login', color: COLORS[0], points: series(s['kmqr.login'] ? 'kmqr.login' : 'browser.step.login', 'p95') },
      { name: 'buka modul', color: COLORS[2], points: series('kmqr.module_load', 'p95') },
      { name: 'refresh metrics', color: COLORS[1], points: series('kmqr.metrics_refresh', 'p95') },
      { name: 'buka halaman login', color: COLORS[3], points: series('browser.step.open_login_page', 'p95') },
    ], ms, overlay),
    lineChart('p95 TTFB halaman per periode', [
      { name: 'TTFB', color: COLORS[1], points: series('browser.page.TTFB.kmqr-user-journey', 'p95') },
    ], ms, overlay),
  ].join('');

  // ---------- Checks (dari .log) ----------
  const checksHtml = runLog.checks.length
    ? `<div class="card checks">${runLog.checks.map((ck) => `<div class="${ck.ok ? 'ok' : 'bad'}">${ck.ok ? '✓' : '✗'} ${esc(ck.text)}</div>`).join('')}</div>`
    : '<p class="muted">Hasil checks tidak tersedia (file .log tidak ditemukan).</p>';
  const passed = runLog.checks.length ? runLog.checks.every((ck) => ck.ok) : null;

  // ---------- VU gagal ----------
  const testStart = runLog.phases.length ? runLog.phases[0].start : agg.firstMetricAt;
  const lastPhase = runLog.phases[runLog.phases.length - 1];
  const phaseAt = (t) => {
    const p = runLog.phases.find((ph) => t >= ph.start && t < ph.end);
    if (p) return p.name;
    return lastPhase && t >= lastPhase.end ? `setelah ${lastPhase.name}` : '-';
  };
  const activeAt = (t) => {
    let v = '-';
    for (const [pt, a] of activeSeries) if (Number(pt) <= t) v = a;
    return v;
  };
  const timeoutOf = (err) => Number((err.match(/Timeout (\d+)ms/) || [])[1] || 0);
  const causeOf = (f) => {
    if (f.cause) return f.cause;
    if (f.consoleErrors === undefined) return 'tidak tercatat (run sebelum fitur ini)';
    return timeoutOf(f.error) ? 'UI tidak merespons, tanpa sinyal error Blazor (server lambat?)' : '-';
  };
  const utc = (t) => new Date(t).toISOString().slice(11, 19);

  // ---------- Klien vs server ----------
  const client = readClient(file);
  const probeOkMs = client ? client.filter((x) => typeof x.probeStatus === 'number' && x.probeStatus < 500).map((x) => x.probeMs) : [];
  const probeBase = median(probeOkMs.slice(0, 6));
  // dns:* / jaringan tak terjangkau = laptop tidak bisa mencapai server (VPN/DNS), bukan kesalahan server
  const probeNetErr = (x) => typeof x.probeStatus === 'string' && (x.probeStatus.startsWith('dns:') || /ENETUNREACH|EHOSTUNREACH/.test(x.probeStatus));
  const probeBad = (x) => x.probeStatus != null && x.probeStatus !== 'error' && !probeNetErr(x) // 'error' polos = run lama, jenisnya tidak diketahui
    && (typeof x.probeStatus !== 'number' || x.probeStatus >= 500 || (probeBase != null && x.probeMs > Math.max(probeBase * 3, probeBase + 1500)));
  // Lag di 10 detik pertama diabaikan: itu waktu Chromium dibuka, bukan tanda laptop kewalahan
  const warmupUntil = client ? client[0].t + 10000 : 0;
  const lagOf = (x) => (x.t > warmupUntil ? x.lagMs || 0 : 0);
  const clientBad = (x) => x.cpu >= CLIENT_LIMITS.cpu || x.freeMb < CLIENT_LIMITS.freeMb || lagOf(x) >= CLIENT_LIMITS.lagMs || probeNetErr(x);
  const http5xx = inter.map((p) => [Number(p.period), Object.entries(p.counters || {})
    .filter(([k]) => /^browser\.page\.codes\.5\d\d$/.test(k)).reduce((sum, [, v]) => sum + v, 0)]);
  const total5xx = http5xx.reduce((sum, [, n]) => sum + n, 0);

  /** Tentukan sisi penyebab satu kegagalan dari sinyal di jendela waktu aksi yang gagal. */
  const classify = (f) => {
    const from = f.time - (timeoutOf(f.error) || 0) - 5000;
    const until = f.time + 5000;
    const server = [];
    const laptop = [];
    if (BROWSER_NET_ERR.test(f.error)) laptop.push('browser tidak bisa mencapai server (DNS/jaringan laptop)');
    if (f.cause && /circuit/i.test(f.cause)) server.push('circuit Blazor dimatikan server');
    else if (f.cause) server.push(`${f.cause} (server/jaringan)`);
    const n5xx = http5xx.filter(([t, n]) => n && t + 10000 >= from && t <= until).reduce((sum, [, n]) => sum + n, 0);
    if (n5xx) server.push(`${n5xx} respons HTTP 5xx`);
    if (client) {
      const win = client.filter((x) => x.t >= from && x.t <= until);
      const slow = win.filter(probeBad);
      if (slow.length) server.push(`probe server lambat/error (maks ${ms(Math.max(...slow.map((x) => x.probeMs)))})`);
      const netErr = win.find(probeNetErr);
      if (netErr) laptop.push(`jaringan laptop tidak bisa mencapai server (${netErr.probeStatus})`);
      if (win.length) {
        const cpuMax = Math.max(...win.map((x) => x.cpu));
        const freeMin = Math.min(...win.map((x) => x.freeMb));
        const lagMax = Math.max(...win.map(lagOf));
        if (cpuMax >= CLIENT_LIMITS.cpu) laptop.push(`CPU laptop ${cpuMax}%`);
        if (freeMin < CLIENT_LIMITS.freeMb) laptop.push(`RAM bebas ${freeMin} MB`);
        if (lagMax >= CLIENT_LIMITS.lagMs) laptop.push(`lag laptop ${ms(lagMax)}`);
      }
    }
    const reasons = [...server, ...laptop];
    if (server.length && laptop.length) return { cls: 'both', label: 'Keduanya', reasons };
    if (server.length) return { cls: 'server', label: 'Server', reasons };
    if (laptop.length) return { cls: 'client', label: 'Laptop', reasons };
    if (client) return { cls: 'server', label: 'Kemungkinan aplikasi', reasons: ['laptop sehat dan probe server normal: masalah di sesi itu saja (mis. exception per user)'] };
    return { cls: 'unknown', label: 'Belum bisa ditentukan', reasons: ['run lama: kondisi laptop tidak direkam'] };
  };

  let validityHtml = `<div class="card note"><p class="muted">Kondisi laptop tidak direkam pada run ini (run sebelum fitur ini). Jalankan ulang lewat <code>npm run …</code> untuk mendapat penilaian klien vs server.</p></div>`;
  if (client) {
    const badSamples = client.filter(clientBad);
    const badPct = Math.round((100 * badSamples.length) / client.length);
    // gabungkan sampel jenuh berurutan menjadi rentang waktu
    const ranges = [];
    for (const x of badSamples) {
      const last = ranges[ranges.length - 1];
      if (last && x.t - last.end <= 10000) {
        last.end = x.t;
        last.cpu = Math.max(last.cpu, x.cpu);
        last.freeMb = Math.min(last.freeMb, x.freeMb);
        last.lag = Math.max(last.lag, lagOf(x));
      } else ranges.push({ start: x.t, end: x.t, cpu: x.cpu, freeMb: x.freeMb, lag: lagOf(x) });
    }
    const rangeText = ranges.slice(0, 6).map((r) => `${fmtClock(r.start)}–${fmtClock(r.end)} (CPU maks ${r.cpu}%, RAM bebas min ${r.freeMb} MB, lag maks ${ms(r.lag)})`).join('; ');
    const slowProbes = client.filter(probeBad).length;
    const netErrs = client.filter(probeNetErr);
    const browserNetFails = failures.filter((f) => BROWSER_NET_ERR.test(f.error));
    const netWhat = netErrs.length
      ? `${netErrs.length} dari ${client.length} sampel probe (${esc(netErrs[0].probeStatus)}, pertama ${fmtClock(netErrs[0].t)})`
      : `${browserNetFails.length} VU (${esc((browserNetFails[0]?.error.match(BROWSER_NET_ERR) || [''])[0])}, pertama ${browserNetFails.length ? fmtClock(browserNetFails[0].time) : '-'})`;
    const verdict = netErrs.length || browserNetFails.length
      ? `<p class="bad">✗ <b>Laptop tidak bisa mencapai server</b> pada ${netWhat}. Ini masalah jaringan/DNS di laptop (mis. belum tersambung VPN/jaringan kantor), bukan server. Hasil test tidak valid: perbaiki koneksi lalu ulangi.</p>`
      : badPct === 0
      ? `<p class="ok">✓ <b>Laptop tidak menjadi bottleneck selama test.</b> Kelambatan atau kegagalan yang tercatat (kalau ada) berasal dari server/aplikasi, jadi hasil ini valid sebagai ukuran server.</p>`
      : badPct < 10
        ? `<p class="warn">⚠ <b>Laptop sempat kewalahan ${badPct}% dari waktu test</b> di rentang: ${rangeText}. Hasil di rentang itu kurang valid; di luar rentang itu valid.</p>`
        : `<p class="bad">✗ <b>Laptop kewalahan ${badPct}% dari waktu test</b> (${rangeText}). Hasil ini tidak valid sebagai ukuran server: kurangi jumlah VU, bebaskan RAM, atau jalankan dari mesin yang lebih kuat.</p>`;
    const serverLine = `<p>Server: probe HTTP baseline <b>${ms(probeBase)}</b>, maks <b>${ms(Math.max(...client.map((x) => x.probeMs || 0)))}</b>, ${slowProbes ? `<b class="bad">${slowProbes} sampel lambat/error</b>` : '0 sampel lambat'}; respons HTTP 5xx: <b>${total5xx}</b>.</p>`;
    const laptopLine = `<p>Laptop: CPU maks <b>${Math.max(...client.map((x) => x.cpu))}%</b>, RAM bebas min <b>${Math.min(...client.map((x) => x.freeMb))} MB</b>, lag maks <b>${ms(Math.max(...client.map(lagOf)))}</b> (batas: CPU ${CLIENT_LIMITS.cpu}%, RAM ${CLIENT_LIMITS.freeMb} MB, lag ${ms(CLIENT_LIMITS.lagMs)}).</p>`;
    const clientCharts = [
      lineChart('Laptop (klien): CPU & RAM', [
        { name: 'CPU %', color: COLORS[2], points: client.map((x) => [x.t, x.cpu]) },
        { name: 'RAM terpakai %', color: COLORS[3], points: client.map((x) => [x.t, x.ramUsedPct]) },
      ], (v) => `${Math.round(v)}%`, overlay),
      lineChart('Probe server vs lag laptop', [
        { name: 'probe server', color: COLORS[1], points: client.filter((x) => x.probeMs != null).map((x) => [x.t, x.probeMs]) },
        { name: 'lag laptop', color: COLORS[4], points: client.map((x) => [x.t, x.lagMs || 0]) },
      ], ms, overlay),
    ].join('');
    validityHtml = `<div class="card note">${verdict}${serverLine}${laptopLine}
<p class="muted">Cara baca: kalau <b>probe server</b> naik saat beban naik, server melambat. Kalau probe tetap rendah tapi <b>CPU/lag laptop</b> tinggi, laptop yang melambat.</p></div>
<div class="charts" style="margin-top:12px">${clientCharts}</div>`;
  }

  let failuresHtml = '<p class="muted">Tidak ada VU yang gagal.</p>';
  if (failures.length) {
    const byPhase = {};
    failures.forEach((f) => { const p = phaseAt(f.time); byPhase[p] = (byPhase[p] || 0) + 1; });
    const circuit = failures.filter((f) => /circuit/i.test(f.cause || '')).length;
    failures.forEach((f) => { f.side = classify(f); });
    const bySide = {};
    failures.forEach((f) => { bySide[f.side.label] = (bySide[f.side.label] || 0) + 1; });
    const sideBadge = (sd) => `<span class="side ${sd.cls}">${esc(sd.label)}</span>`;
    const groups = {};
    failures.forEach((f) => {
      const key = `${f.step}|${f.error}|${causeOf(f)}|${f.side.label}`;
      groups[key] = groups[key] || { step: f.step, error: f.error, cause: causeOf(f), side: f.side, n: 0, phases: new Set() };
      groups[key].n++;
      groups[key].phases.add(phaseAt(f.time));
    });
    const summary = [
      `<b>${failures.length} VU gagal</b> antara ${fmtClock(failures[0].time)} (${fmtOffset(failures[0].time - testStart)}) dan ${fmtClock(failures[failures.length - 1].time)} (${fmtOffset(failures[failures.length - 1].time - testStart)}).`,
      `Per phase: ${Object.entries(byPhase).map(([p, n]) => `${esc(p)} ${n}×`).join(', ')}.`,
      `Per sisi penyebab: ${Object.entries(bySide).map(([lbl, n]) => `${esc(lbl)} ${n}×`).join(', ')}.`,
      circuit ? `<b>${circuit}</b> di antaranya didahului <b>circuit Blazor dimatikan server</b>: cocokkan jamnya (kolom UTC) dengan exception di log pod.` : '',
      failures.some((f) => timeoutOf(f.error)) ? 'Untuk error timeout, screenshot diambil setelah timeout habis; kolom "mulai macet" menunjukkan kapan aksi itu mulai menunggu.' : '',
    ].filter(Boolean).map((t) => `<p>${t}</p>`).join('');

    const groupRows = Object.values(groups).sort((a, b) => b.n - a.n).map((g) =>
      `<tr><td>${esc(g.step)}</td><td class="wrap">${esc(g.error)}</td><td class="wrap">${esc(g.cause)}</td><td>${sideBadge(g.side)}</td><td>${[...g.phases].map(esc).join(', ')}</td><td><b>${g.n}</b></td></tr>`).join('');

    const detailRows = failures.map((f, i) => {
      const to = timeoutOf(f.error);
      const shot = f.screenshot ? `<a href="screenshots/${encodeURIComponent(f.screenshot)}" target="_blank">lihat</a>` : '-';
      const consoleInfo = f.consoleErrors && f.consoleErrors.length
        ? `<details><summary>console browser</summary><pre>${esc(f.consoleErrors.join('\n'))}</pre></details>` : '';
      return `<tr><td>${i + 1}</td><td>${fmtClock(f.time)}<div class="muted">${utc(f.time)} UTC</div></td><td>${fmtOffset(f.time - testStart)}</td>`
        + `<td>${esc(phaseAt(f.time))}</td><td>${activeAt(f.time)}</td><td>${to ? fmtClock(f.time - to) : '-'}</td>`
        + `<td>${esc(f.vu)}<div class="muted">${esc((f.user || '').split('@')[0])}</div></td><td>${esc(f.step)}</td>`
        + `<td class="wrap">${esc(f.error)}${consoleInfo}</td><td class="wrap">${esc(causeOf(f))}</td>`
        + `<td class="wrap">${sideBadge(f.side)}<div class="muted">${esc(f.side.reasons.join('; '))}</div></td><td>${shot}</td></tr>`;
    }).join('');

    failuresHtml = `<div class="card note">${summary}</div>
<h3>Ringkasan penyebab</h3>
<div class="card"><table><tr><th>Langkah</th><th>Error</th><th>Penyebab terdeteksi</th><th>Sisi</th><th>Phase</th><th>Jumlah</th></tr>${groupRows}</table></div>
<h3>Detail per VU</h3>
<div class="card"><table><tr><th>#</th><th>Jam gagal</th><th>Menit ke</th><th>Phase</th><th>VU aktif</th><th>Mulai macet</th><th>VU</th><th>Langkah</th><th>Error</th><th>Penyebab</th><th>Sisi</th><th>Screenshot</th></tr>${detailRows}</table></div>`;
  }

  const head = '<tr><th>Langkah</th><th>n</th><th>min</th><th>median</th><th>p90</th><th>p95</th><th>p99</th><th>max</th></tr>';

  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KMQR Load Test Report</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#66717d;--line:#e3e7eb;--good:#1baf7a;--bad:#d64545;--warn:#d98a1c}
@media (prefers-color-scheme:dark){:root{--bg:#14181c;--card:#1d2329;--text:#e6e9ec;--muted:#98a3ae;--line:#2e363e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.tile .label{color:var(--muted);font-size:12px}
.tile .val{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.tile.good .val{color:var(--good)}.tile.bad .val{color:var(--bad)}.tile.warn .val{color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{font-weight:600;color:var(--muted);font-size:12px}tr:last-child td{border-bottom:0}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:12px}
.chart{position:relative;margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}figcaption{font-weight:600;margin-bottom:4px}
.chart svg{width:100%;height:auto;display:block}.grid{stroke:var(--line)}.tick{fill:var(--muted);font-size:11px}
.hover-line{stroke:var(--muted);stroke-dasharray:3 3}.hover-dot{stroke:var(--card);stroke-width:2}.hit{cursor:crosshair}
.tip{position:absolute;display:none;pointer-events:none;z-index:2;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.18);white-space:nowrap}
.tip-time{color:var(--muted);margin-bottom:3px}.tip-row{display:flex;align-items:center;gap:6px}.tip-row i{width:8px;height:8px;border-radius:2px;display:inline-block}.tip-row b{margin-left:auto;padding-left:14px;font-variant-numeric:tabular-nums}
.phase-line{stroke:var(--muted);stroke-dasharray:2 4;opacity:.7}.phase-label{fill:var(--muted);font-size:10px}
.fail-mark{fill:var(--bad)}.fail-legend{display:inline-block;width:0!important;height:0!important;border-radius:0!important;background:none!important;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid var(--bad)}
.tip-fail{color:var(--bad)}
h3{font-size:14px;margin:18px 0 8px}.note{padding:4px 14px}.note p{margin:8px 0}
.note .ok{color:var(--good)}.note .warn{color:var(--warn)}.note .bad,b.bad{color:var(--bad)}
.side{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.side.server{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}
.side.client{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.side.both{background:color-mix(in srgb,#9b5de5 18%,transparent);color:#9b5de5}
.side.unknown{background:color-mix(in srgb,var(--muted) 18%,transparent);color:var(--muted)}
.checks{padding:10px 14px}.checks .ok{color:var(--good)}.checks .bad{color:var(--bad)}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;margin-left:8px;vertical-align:3px}
.status.ok{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}.status.bad{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
td.wrap{white-space:normal;min-width:180px;text-align:left}details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:12px}
pre{white-space:pre-wrap;font-size:11px;margin:4px 0 0;max-width:420px}a{color:#2a78d6}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
</style></head><body><main>
<h1>KMQR Load Test Report${passed == null ? '' : passed ? '<span class="status ok">PASSED</span>' : '<span class="status bad">FAILED</span>'}</h1>
<div class="muted">${esc(path.basename(file))} · ${fmtTime(agg.firstMetricAt)} – ${fmtTime(agg.lastMetricAt)}</div>
<div class="tiles">${tiles}</div>
<h2>Checks</h2>${checksHtml}
<h2>Grafik</h2><div class="charts">${charts}</div>
<h2>Validitas: laptop atau server?</h2>${validityHtml}
<h2>VU gagal</h2>${failuresHtml}
<h2>Waktu per langkah</h2><div class="card"><table>${head}${stepRows}</table></div>
<h2>Web vitals halaman</h2><div class="card"><table>${head.replace('Langkah', 'Metrik')}${vitalRows}</table></div>
<h2>Error &amp; retry</h2><div class="card">${problems ? `<table><tr><th>Counter</th><th>Jumlah</th></tr>${problems}</table>` : '<p class="muted" style="padding:12px;margin:0">Tidak ada error.</p>'}</div></main><script>${HOVER_SCRIPT}</script></body></html>`;
}

/** Tulis report HTML di sebelah file JSON, kembalikan path-nya. */
function writeReport(input) {
  const output = input.replace(/\.json$/i, '.html');
  fs.writeFileSync(output, build(input));
  return output;
}

if (require.main === module) {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : latestJson();
  console.log(`Report dibuat: ${writeReport(input)}`);
}

module.exports = { writeReport };
