/**
 * Menjalankan load test dengan tampilan live ringkas di terminal (mirip k6).
 * Output mentah Artillery tidak ditampilkan, tapi disimpan ke results/<nama>.log.
 * Setelah selesai, report HTML dibuat otomatis.
 *
 * Pemakaian:
 *   node run.js <smoke|debug|load|stress> [argumen artillery lain, mis. -t https://url-lain]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const { writeReport } = require('./report');

const ENV = process.argv[2];
const EXTRA = process.argv.slice(3);
const CONFIG_FILE = path.join(__dirname, 'kmqr.yml');
const ARTILLERY = path.join(__dirname, 'node_modules', 'artillery', 'bin', 'run');
const RESULTS_DIR = path.join(__dirname, 'results');

const config = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')).config;
const envs = Object.keys(config.environments || {});
if (!envs.includes(ENV)) {
  console.error(`Usage: node run.js <${envs.join('|')}> [extra artillery args]`);
  process.exit(2);
}

const phases = config.environments[ENV].phases || [];
const plannedSeconds = phases.reduce((sum, p) => sum + (p.duration || 0), 0);
const plannedVus = phases.reduce((sum, p) => sum + (p.arrivalCount || (p.arrivalRate || 0) * (p.duration || 0)), 0);
const targetIdx = EXTRA.findIndex((a) => a === '-t' || a === '--target');
const target = targetIdx >= 0 ? EXTRA[targetIdx + 1] : config.target;

const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
const baseName = `kmqr_${ENV}_${stamp}`;
const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`);
const logPath = path.join(RESULTS_DIR, `${baseName}.log`);
const rel = (p) => path.relative(__dirname, p);

// ---------- tampilan ----------
const TTY = process.stdout.isTTY;
const COLOR = TTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2'), red = paint('31'), green = paint('32'), yellow = paint('33'), cyan = paint('36');

const fmtMs = (ms) => (ms == null ? '-' : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(0)}s`);
const fmtClock = (s) => `${pad2(Math.floor(s / 60))}:${pad2(Math.floor(s % 60))}`;
const timeOfDay = () => new Date().toLocaleTimeString('id-ID', { hour12: false });
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function stats(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { n: v.length, median: q(0.5), p95: q(0.95), max: v[v.length - 1] };
}

// ---------- state ----------
const state = {
  launchedAt: Date.now(),
  testStartedAt: null,
  phase: null,
  phaseIndex: -1,
  phasesDone: false,
  started: 0,
  done: 0,
  failed: 0,
  retries: 0,
  logoutFailed: 0,
  samples: { open_login_page: [], login: [], module: [], session: [] },
  recent: [],
  checks: [],
  stopping: false,
  cpu: 0,
  cpuMax: 0,
  freeMinGb: null,
  skipped: 0,
  lagMs: 0, // lag event loop proses browser (dari flows.js), maks per 5 detik
  lagMax: 0,
  probeMs: null, // waktu respons probe HTTP ke server
  probeStatus: null,
  probeOk: [], // sampel probe yang berhasil, untuk baseline
  probeMax: 0,
};

// CPU laptop (klien): kalau mendekati 100%, laptop yang jadi bottleneck, bukan server
function cpuTimes() {
  return os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
}
let lastCpu = cpuTimes();
setInterval(() => {
  const now = cpuTimes();
  const total = now.total - lastCpu.total;
  state.cpu = total ? Math.round(100 * (1 - (now.idle - lastCpu.idle) / total)) : 0;
  if (state.testStartedAt) {
    state.cpuMax = Math.max(state.cpuMax, state.cpu);
    const free = os.freemem() / 2 ** 30;
    state.freeMinGb = state.freeMinGb == null ? free : Math.min(state.freeMinGb, free);
  }
  lastCpu = now;
}, 2000).unref();

const CPU_WARN = 85;
const RAM_WARN_GB = 1.5;
const LAG_WARN_MS = 1000;

/**
 * Probe server: 1 request GET ringan tiap 5 detik, terpisah dari browser VU.
 * Kalau probe ikut melambat/error saat beban naik, servernya yang melambat.
 * Kalau probe tetap cepat tapi langkah VU lambat dan CPU/lag laptop tinggi, laptop yang jadi bottleneck.
 */
async function probeServer() {
  const t0 = Date.now();
  try {
    const res = await fetch(new URL('/Auth/Login', target), { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    state.probeMs = Date.now() - t0;
    state.probeStatus = res.status;
    res.body?.cancel().catch(() => {});
    if (res.status < 500) state.probeOk.push(state.probeMs);
  } catch (err) {
    state.probeMs = Date.now() - t0;
    state.probeStatus = err.name === 'TimeoutError' ? 'timeout' : 'error';
  }
  state.probeMax = Math.max(state.probeMax, state.probeMs);
}
const probeBaseline = () => {
  const first = state.probeOk.slice(0, 6).sort((a, b) => a - b);
  return first.length ? first[Math.floor(first.length / 2)] : null;
};
const probeSlow = () => {
  const base = probeBaseline();
  if (typeof state.probeStatus !== 'number' || state.probeStatus >= 500) return state.probeStatus != null;
  return base != null && state.probeMs > Math.max(base * 3, base + 1500);
};

// Kondisi laptop & server tiap 5 detik -> <nama>.client.jsonl (dibaca report.js untuk memisahkan masalah klien vs server)
let clientLog = null;
setInterval(async () => {
  if (!state.testStartedAt || !clientLog) return;
  await probeServer();
  const free = os.freemem();
  fs.appendFileSync(clientLog, `${JSON.stringify({
    t: Date.now(),
    cpu: state.cpu,
    ramUsedPct: Math.round(100 * (1 - free / os.totalmem())),
    freeMb: Math.round(free / 1048576),
    lagMs: state.lagMs,
    probeMs: state.probeMs,
    probeStatus: state.probeStatus,
    activeVus: state.started - state.done - state.failed,
  })}\n`);
}, 5000).unref();

// Perkiraan RAM puncak: browser ±0.5 GB (termasuk Node/Artillery) + ±0.15 GB per VU bersamaan (diukur di KMQR)
const GB_PER_VU = 0.15;
const peakVus = Math.max(...phases.map((p) => p.maxVusers || p.arrivalCount || 1));
const neededGb = 0.5 + peakVus * GB_PER_VU;
const freeAtStartGb = os.freemem() / 2 ** 30;
const fitsVus = Math.max(0, Math.floor((freeAtStartGb - 0.5 - 0.7) / GB_PER_VU));

function addRecent(text) {
  state.recent.push(`${dim(timeOfDay())}  ${text}`);
  if (state.recent.length > 4) state.recent.shift();
}

function onEvent(e) {
  switch (e.t) {
    case 'vu_start':
      state.started++;
      break;
    case 'step':
      (state.samples[e.name] || (state.samples[e.name] = [])).push(e.ms);
      break;
    case 'retry':
      state.retries++;
      addRecent(yellow(`login retry  vu=${e.vu}  (${e.reason})`));
      break;
    case 'logout_fail':
      state.logoutFailed++;
      addRecent(yellow(`logout failed  vu=${e.vu}`));
      break;
    case 'vu_skip':
      state.skipped++;
      addRecent(red(`VU skipped: laptop free RAM ${e.freeMb} MB`));
      break;
    case 'vu_fail':
      state.failed++;
      addRecent(red(`VU failed at ${e.step}  vu=${e.vu}  ${cut(e.error || '', 70)}`));
      break;
    case 'vu_done':
      state.done++;
      state.samples.session.push(e.ms);
      break;
    case 'lag':
      state.lagMs = e.ms;
      if (state.testStartedAt) state.lagMax = Math.max(state.lagMax, e.ms);
      break;
  }
}

function onArtilleryLine(line) {
  const started = line.match(/Phase started: (.+?) \(index: (\d+), duration: (\d+)s\)/);
  if (started) {
    state.testStartedAt = state.testStartedAt || Date.now();
    state.phase = started[1];
    state.phaseIndex = Number(started[2]);
  }
  const completed = line.match(/Phase completed: .+? \(index: (\d+)/);
  if (completed && Number(completed[1]) === phases.length - 1) state.phasesDone = true;
  const check = line.match(/^\s*(ok|fail): (.+)$/);
  if (check) state.checks.push({ ok: check[1] === 'ok', text: check[2].trim() });
}

function frame() {
  const lines = [];
  lines.push(`${bold('KMQR load test')}  ${dim('·')}  ${cyan(ENV)}  ${dim('·')}  ${target}`);
  if (neededGb > freeAtStartGb - 0.7) {
    lines.push(yellow(`RAM: up to ${peakVus} VUs need ~${neededGb.toFixed(1)} GB, only ${freeAtStartGb.toFixed(1)} GB free (fits ~${fitsVus} VUs)`));
  }
  lines.push('');

  const active = state.started - state.done - state.failed;
  if (!state.testStartedAt) {
    lines.push(`${yellow('starting  ')}  launching browser & Artillery... ${dim(fmtClock((Date.now() - state.launchedAt) / 1000))}`);
  } else {
    const elapsed = (Date.now() - state.testStartedAt) / 1000;
    const pct = plannedSeconds ? Math.min(1, elapsed / plannedSeconds) : 1;
    const width = 30;
    const filled = Math.round(pct * width);
    const bar = green('█'.repeat(filled)) + dim('░'.repeat(width - filled));
    const status = state.stopping ? red('stopping  ') : state.phasesDone ? yellow('finishing ') : green('running   ');
    lines.push(`${status}  ${fmtClock(elapsed)} / ${fmtClock(plannedSeconds)}  ${bar}  ${String(Math.round(pct * 100)).padStart(3)}%`);
    const phaseText = state.phasesDone
      ? `all phases done, waiting for ${active} active VU(s) to finish`
      : `${state.phase} (${state.phaseIndex + 1}/${phases.length})`;
    lines.push(`${dim('phase')}       ${phaseText}`);
  }
  lines.push('');

  const failedText = state.failed ? red(`failed ${state.failed}`) : green('failed 0');
  lines.push(`${dim('VUs')}         active ${bold(Math.max(0, active))}  ·  done ${green(state.done)}  ·  ${failedText}  ·  started ${state.started}/${plannedVus}`);
  const retryText = state.retries ? yellow(`retries ${state.retries}`) : 'retries 0';
  const logoutText = state.logoutFailed ? yellow(`logout failed ${state.logoutFailed}`) : 'logout failed 0';
  lines.push(`${dim('login')}       ${retryText}  ·  ${logoutText}`);
  const freeGb = os.freemem() / 2 ** 30;
  const cpuText = state.cpu >= CPU_WARN ? yellow(`CPU ${state.cpu}% (laptop may be the bottleneck)`) : `CPU ${state.cpu}%`;
  const freeText = `RAM free ${freeGb.toFixed(1)} GB`;
  const ramText = freeGb < RAM_WARN_GB ? red(`${freeText} (low)`) : freeText;
  const minText = state.freeMinGb == null ? '' : `  ·  min ${state.freeMinGb.toFixed(1)} GB`;
  const lagText = state.lagMs >= LAG_WARN_MS ? yellow(`lag ${fmtMs(state.lagMs)}`) : `lag ${fmtMs(state.lagMs)}`;
  lines.push(`${dim('client')}      ${cpuText}  ·  max ${state.cpuMax}%  ·  ${ramText}${minText}  ·  ${lagText}`);
  if (state.skipped) lines.push(`${dim('')}            ${red(`${state.skipped} VU(s) skipped because laptop RAM was low`)}`);
  if (state.probeMs != null) {
    const base = probeBaseline();
    const now = typeof state.probeStatus === 'number' && state.probeStatus < 500 ? fmtMs(state.probeMs) : `${state.probeStatus}`;
    const probeText = probeSlow() ? red(`probe ${now} (slow/error)`) : `probe ${now}`;
    lines.push(`${dim('server')}      ${probeText}  ·  baseline ${fmtMs(base)}  ·  max ${fmtMs(state.probeMax)}`);
  }
  lines.push('');

  lines.push(dim(`${'step'.padEnd(18)}${'n'.padStart(5)}${'median'.padStart(10)}${'p95'.padStart(10)}${'max'.padStart(10)}`));
  const rows = [
    ['open login page', 'open_login_page'],
    ['login', 'login'],
    ['open module', 'module'],
    ['refresh data', 'refresh'],
    ['session length', 'session'],
  ];
  for (const [label, key] of rows) {
    const s = stats(state.samples[key] || []);
    lines.push(
      s
        ? `${label.padEnd(18)}${String(s.n).padStart(5)}${fmtMs(s.median).padStart(10)}${bold(fmtMs(s.p95).padStart(10))}${fmtMs(s.max).padStart(10)}`
        : `${label.padEnd(18)}${dim('    -')}`
    );
  }

  // "recent events" diletakkan paling bawah dan dipotong dulu kalau terminal terlalu pendek
  const maxLines = Math.max(10, (process.stdout.rows || 40) - 1);
  const room = maxLines - lines.length - 2;
  if (state.recent.length && room > 0) {
    lines.push('');
    lines.push(dim('recent events'));
    lines.push(...state.recent.slice(-room));
  }
  return lines.slice(0, maxLines);
}

/**
 * Potong baris ke lebar terminal (kode warna ANSI tidak dihitung).
 * Baris yang lebih lebar dari terminal akan terbungkus, sehingga redraw salah menghitung jumlah baris
 * dan bagian atas dashboard (progress bar) terdorong keluar layar.
 */
function fitWidth(line, width) {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width - 1) return `${out}…\x1b[0m`;
    out += line[i];
    visible++;
  }
  return out;
}

let prevLines = 0;
function draw() {
  const width = process.stdout.columns || 100;
  const lines = frame().map((l) => fitWidth(l, width));
  let out = prevLines ? `\x1b[${prevLines}F` : '';
  out += lines.map((l) => `${l}\x1b[K`).join('\n') + '\n\x1b[J';
  process.stdout.write(out);
  prevLines = lines.length;
}

// Ukuran terminal berubah: baris lama bisa terbungkus ulang, jadi bersihkan layar dan gambar ulang dari atas
if (TTY) {
  process.stdout.on('resize', () => {
    process.stdout.write('\x1b[2J\x1b[H');
    prevLines = 0;
    draw();
  });
}

function plainStatus() {
  const s = stats(state.samples.login) || {};
  const m = stats(state.samples.module) || {};
  const r = stats(state.samples.refresh || []) || {};
  const elapsed = state.testStartedAt ? fmtClock((Date.now() - state.testStartedAt) / 1000) : '--:--';
  console.log(`[${elapsed}/${fmtClock(plannedSeconds)}] phase=${state.phase || '-'} active=${state.started - state.done - state.failed} done=${state.done} failed=${state.failed} retries=${state.retries} login.p95=${fmtMs(s.p95)} module.p95=${fmtMs(m.p95)} refresh.p95=${fmtMs(r.p95)}`);
}

// ---------- jalankan artillery ----------
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const log = fs.createWriteStream(logPath);
clientLog = path.join(RESULTS_DIR, `${baseName}.client.jsonl`);

const child = spawn(process.execPath, [ARTILLERY, 'run', CONFIG_FILE, '-e', ENV, '-o', jsonPath, ...EXTRA], {
  cwd: __dirname,
  env: { ...process.env, KMQR_LIVE: '1', FORCE_COLOR: '0', KMQR_FAILURES_FILE: path.join(RESULTS_DIR, `${baseName}.failures.jsonl`) },
});

function readLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => buf && onLine(buf));
}

readLines(child.stdout, (line) => {
  if (line.startsWith('@@KMQR ')) {
    try {
      onEvent(JSON.parse(line.slice(7)));
    } catch (_) {
      /* baris rusak, abaikan */
    }
    return;
  }
  log.write(`${line}\n`);
  onArtilleryLine(line);
});
readLines(child.stderr, (line) => log.write(`${line}\n`));

if (TTY) process.stdout.write('\x1b[?25l'); // sembunyikan kursor
const timer = TTY ? setInterval(draw, 500) : setInterval(plainStatus, 10000);
if (TTY) draw();

// Ctrl+C sampai juga ke Artillery (satu console), jadi cukup tandai; Ctrl+C kedua memaksa berhenti
process.on('SIGINT', () => {
  if (state.stopping) child.kill('SIGKILL');
  state.stopping = true;
});

child.on('exit', (code) => {
  clearInterval(timer);
  log.end();
  if (TTY) {
    draw();
    process.stdout.write('\x1b[?25h');
  } else {
    plainStatus();
  }

  console.log('');
  if (state.checks.length) {
    console.log(bold('checks'));
    for (const c of state.checks) console.log(`  ${c.ok ? green('✓') : red('✗')} ${c.text}`);
    console.log('');
  }

  if (state.skipped || (state.freeMinGb != null && state.freeMinGb < RAM_WARN_GB)) {
    console.log(yellow(`warning     laptop free RAM dropped to ${state.freeMinGb.toFixed(1)} GB${state.skipped ? `, ${state.skipped} VU(s) skipped` : ''}: lower the VU count or free up RAM`));
    console.log('');
  }
  if (state.cpuMax >= CPU_WARN) {
    console.log(yellow(`warning     client CPU reached ${state.cpuMax}%: slow results may come from this laptop, not the server`));
    console.log('');
  }
  const passed = code === 0;
  console.log(`${bold('status')}      ${passed ? green('PASSED') : red(`FAILED (exit code ${code})`)}`);
  if (fs.existsSync(jsonPath)) {
    try {
      console.log(`${bold('report')}      ${rel(writeReport(jsonPath))}`);
    } catch (err) {
      console.log(`${bold('report')}      ${red(`could not be created: ${err.message}`)}`);
    }
  }
  console.log(`${bold('log')}         ${rel(logPath)}`);
  if (state.failed) console.log(`${bold('screenshot')}  ${rel(path.join(RESULTS_DIR, 'screenshots'))}`);

  if (!fs.existsSync(jsonPath)) {
    // Kemungkinan Artillery gagal start: tampilkan akhir log supaya penyebabnya terlihat
    const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-15);
    if (tail.length) console.log(`\n${dim('end of log:')}\n${tail.join('\n')}`);
  }
  process.exit(code == null ? 1 : code);
});
