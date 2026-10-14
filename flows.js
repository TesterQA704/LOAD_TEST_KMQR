/**
 * Alur user KMQR untuk Artillery (engine Playwright).
 * Locator diambil dari project Playwright Automation_KMQR.
 *
 * Satu sesi: buka KMQR -> login -> buka beberapa modul secara acak -> logout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Bisa di-override lewat environment variable sebelum menjalankan artillery
const MODULE_CLICKS = parseInt(process.env.MODULE_CLICKS || '5', 10);
const THINK_MIN = parseFloat(process.env.THINK_MIN || '10');
const THINK_MAX = parseFloat(process.env.THINK_MAX || '15');
const LOGIN_ATTEMPTS = parseInt(process.env.LOGIN_ATTEMPTS || '3', 10);
const LOGIN_WAIT = parseFloat(process.env.LOGIN_WAIT || '60'); // detik maksimal tunggu login yang sedang diproses server
// Klik dianggap diabaikan kalau selama ini tidak ada event Blazor terkirim / navigasi.
// Normalnya event terkirim < 100 ms, tapi saat CPU klien penuh (stress) bisa terlambat beberapa detik.
const CLICK_IGNORED_MS = 5000;
const LOGIN_SETTLE = parseFloat(process.env.LOGIN_SETTLE || '1'); // detik cek isian form tidak hilang sebelum klik
const SCREENSHOT_DIR = path.join(__dirname, 'results', 'screenshots');
// VU baru dilewati kalau RAM bebas laptop di bawah ini (MB), supaya laptop tidak macet/swap. 0 = nonaktif
const MIN_FREE_RAM_MB = parseInt(process.env.MIN_FREE_RAM_MB || '700', 10);

// Diset oleh run.js: kirim event ke tampilan live di terminal
const LIVE = process.env.KMQR_LIVE === '1';
function live(type, data) {
  if (LIVE) process.stdout.write(`@@KMQR ${JSON.stringify({ t: type, ...data })}\n`);
}

// Lag event loop proses yang menjalankan Playwright: seberapa terlambat timer 500 ms berjalan.
// Kalau > 1 detik, laptop kewalahan menjalankan browser, jadi kelambatan/timeout bisa berasal dari laptop.
if (LIVE) {
  let expected = Date.now() + 500;
  let maxLag = 0;
  setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + 500;
  }, 500).unref();
  setInterval(() => {
    live('lag', { ms: maxLag });
    maxLag = 0;
  }, 5000).unref();
}

/**
 * Filter untuk modul metrics (SBU TEST, Type Quality). Nilai dipilih acak dari kombinasi yang berisi data.
 *
 * PENTING: REFRESH di Metrics Result Input MEMBUAT draft dokumen baru kalau dokumen bulan tersebut belum ada.
 * Karena itu Result Input/Review hanya memakai Year 2027 + Site FinalTest, yang dokumennya sudah ada untuk
 * Jan-Dec. Kalau mengubah nilai di sini, pastikan dulu dokumennya sudah ada (cek di Document List).
 */
const METRICS_FILTERS = {
  target: { sbu: 'TEST', type: 'Quality', years: ['2026'], sites: ['test', 'FinalTest'] },
  result: {
    sbu: 'TEST',
    type: 'Quality',
    years: ['2027'],
    sites: ['FinalTest'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
};

/**
 * Modul yang dibuka secara acak, hanya aksi baca (jangan isi aksi approve/submit/delete).
 * name    = teks link di sidebar
 * group   = tombol grup sidebar tempat link berada (harus terbuka supaya link bisa diklik)
 * path    = URL tujuan
 * heading = judul halaman (h5), bisa beda dengan nama menu
 * filters = (khusus metrics) filter yang dipilih lalu REFRESH data
 */
const MODULES = [
  { name: 'Metrics Target Corporate', group: 'Toggle Metrics Detail', path: '/MetricsDetail/MetricsTargetCorp', heading: 'Metrics Target - Corporate', filters: METRICS_FILTERS.target },
  { name: 'Metrics Target Site', group: 'Toggle Metrics Detail', path: '/MetricsDetail/MetricsTargetSite', heading: 'Metrics Target - Site', filters: METRICS_FILTERS.target },
  { name: 'Metrics Target Approval', group: 'Toggle Metrics Detail', path: '/MetricsDetail/MetricsTargetApproval', heading: 'Metrics Target - Approval', filters: METRICS_FILTERS.target },
  { name: 'Metrics Result Input', group: 'Toggle Metrics Detail', path: '/MetricsDetail/MetricsResultInput', heading: 'Metrics Result - Input', filters: METRICS_FILTERS.result },
  { name: 'Metrics Result Review', group: 'Toggle Metrics Detail', path: '/MetricsDetail/MetricsResultReview', heading: 'Metrics Result - Review', filters: METRICS_FILTERS.result },
  { name: 'Picapa Sira', group: 'Toggle Dashboard Reporting', path: '/Dashboard/PicapaSira', heading: 'PICAPA/SIRA' },
  { name: 'Audit Trail', group: 'Toggle Dashboard Reporting', path: '/Dashboard/AuditTrail', heading: 'Audit Trail' },
  { name: 'Document List', group: 'Toggle Dashboard Reporting', path: '/Dashboard/DocumentList', heading: 'Document List' },
];
const METRICS_MODULES = MODULES.filter((m) => m.filters);

const MENU_TOGGLES = ['Toggle Metrics Detail', 'Toggle Dashboard Reporting'];

// Indikator loading MudBlazor (tabel/progress); halaman dianggap selesai dimuat kalau sudah hilang
const LOADING_SELECTOR = '.mud-table-loading, .mud-progress-linear, .mud-progress-circular';

function slug(text) {
  return text.toLowerCase().replace(/\W+/g, '_');
}

async function think(page) {
  const seconds = THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
  await page.waitForTimeout(seconds * 1000);
}

const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

/** Pilih modul acak (tidak sama berturut-turut), dengan minimal 1 modul metrics per VU. */
function pickModules(count) {
  const picked = [];
  for (let i = 0; i < count; i++) {
    let mod;
    do {
      mod = randomOf(MODULES);
    } while (mod === picked[i - 1]);
    picked.push(mod);
  }
  if (count > 0 && !picked.some((m) => m.filters)) {
    const i = Math.floor(Math.random() * count);
    picked[i] = randomOf(METRICS_MODULES.filter((m) => m !== picked[i - 1] && m !== picked[i + 1]));
  }
  return picked;
}

function loginElements(page) {
  return {
    username: page.getByRole('textbox', { name: 'Username*' }),
    password: page.getByRole('textbox', { name: 'Password*' }),
    signIn: page.locator("xpath=//span[contains(.,'Sign In')]"),
    home: page.getByRole('button', { name: 'Toggle Metrics Detail' }),
    invalid: page.getByText('Username or Password is invalid'),
    loginPage: page.getByText('(Kalbe/Key Metrics - Manufacturing, Quality, Regulatory)'),
  };
}

// Isi field; null kalau field tidak ada (mis. halaman sedang pindah). Timeout pendek supaya tidak menahan 30 detik.
const valueOf = (locator) => locator.inputValue({ timeout: 500 }).catch(() => null);

/**
 * Isi form login dan pastikan isinya bertahan LOGIN_SETTLE detik.
 * Saat circuit Blazor baru siap (lebih lambat kalau server sibuk), form di-render ulang dan isian hilang.
 */
async function fillLoginForm(page, els, user, events) {
  for (let i = 0; i < 5; i++) {
    await els.username.fill(user.username);
    await els.password.fill(user.password);

    let cleared = false;
    const end = Date.now() + LOGIN_SETTLE * 1000;
    while (!cleared && Date.now() < end) {
      await page.waitForTimeout(100);
      cleared = !(await valueOf(els.username)) || !(await valueOf(els.password));
    }
    if (!cleared) return;
    events.emit('counter', 'kmqr.login_form_reset', 1);
  }
  throw new Error('Login form inputs keep getting cleared (Blazor re-render)');
}

/**
 * Hitung event UI yang dikirim browser ke server Blazor.
 * Klik yang benar-benar diproses selalu mengirim frame WebSocket "BeginInvokeDotNetFromJS" dalam < 100 ms.
 * Kalau SignalR pindah ke long polling (bisa terjadi saat server sibuk), event dikirim lewat POST /_blazor.
 * Harus dipasang sebelum page.goto supaya koneksi Blazor ikut terpantau.
 */
function trackBlazorEvents(page) {
  const tracker = { sent: 0 };
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('latin1');
      if (payload.includes('BeginInvokeDotNetFromJS')) tracker.sent++;
    });
  });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/_blazor')) tracker.sent++;
  });
  return tracker;
}

/**
 * Tunggu hasil klik Sign In:
 * - 'home'    : berhasil masuk
 * - 'invalid' : kredensial ditolak
 * - 'cleared' : form kosong >= 1 detik tanpa navigasi (klik terkirim dengan form kosong) -> retry
 * - 'ignored' : CLICK_IGNORED_MS tanpa event Blazor terkirim dan tanpa navigasi (handler belum siap) -> retry
 * - 'timeout' : login sedang diproses tapi tidak selesai dalam LOGIN_WAIT detik
 */
async function waitLoginResult(page, els, blazor) {
  let navigated = false;
  const onNav = (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on('framenavigated', onNav);
  try {
    const clickedAt = Date.now();
    const sentBefore = blazor.sent;
    const end = clickedAt + LOGIN_WAIT * 1000;
    let emptySince = null;
    while (Date.now() < end) {
      try {
        await els.home.or(els.invalid).first().waitFor({ state: 'visible', timeout: 500 });
        return (await els.invalid.isVisible()) ? 'invalid' : 'home';
      } catch (_) {
        /* belum ada hasil */
      }
      if (navigated) continue; // login sedang diproses (pindah halaman), tunggu saja

      if (blazor.sent === sentBefore && Date.now() - clickedAt >= CLICK_IGNORED_MS) return 'ignored';
      if ((await valueOf(els.username)) === '') {
        emptySince = emptySince || Date.now();
        if (Date.now() - emptySince >= 1000) return 'cleared';
      } else {
        emptySince = null;
      }
    }
    return 'timeout';
  } finally {
    page.off('framenavigated', onNav);
  }
}

const RETRY_REASONS = {
  cleared: 'form was cleared after click',
  ignored: 'click was not processed by Blazor',
};

/**
 * Login dengan retry. Kadang login tidak jalan karena form login belum benar-benar siap
 * (Blazor me-render ulang form / handler klik belum terpasang, lebih sering saat server sibuk).
 * Isian yang hilang dicegah lewat fillLoginForm; klik yang tidak diproses dideteksi waitLoginResult
 * lalu langsung diulang. Login yang sedang diproses server ditunggu, tidak diulang.
 * Metrik kmqr.login = waktu dari klik Sign In sampai menu utama tampil (percobaan yang berhasil saja).
 */
async function login(page, user, events, vuId, blazor) {
  const els = loginElements(page);
  let start = null;
  const success = () => {
    const ms = Date.now() - start;
    events.emit('histogram', 'kmqr.login', ms);
    live('step', { vu: vuId, name: 'login', ms });
  };

  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    // Klik sebelumnya ternyata tetap diproses (terlambat): sudah masuk, tidak perlu login ulang
    await els.home.or(els.username).first().waitFor({ state: 'visible' });
    if (start && (await els.home.isVisible())) return success();

    try {
      await page.waitForLoadState('networkidle');
      await fillLoginForm(page, els, user, events);
      const clickAt = Date.now();
      await els.signIn.click();
      start = clickAt;
    } catch (err) {
      // Klik sebelumnya ternyata diproses saat form sedang diisi ulang: halaman pindah ke home
      const lateLogin = start && (await els.home.waitFor({ state: 'visible', timeout: LOGIN_WAIT * 1000 }).then(() => true, () => false));
      if (lateLogin) return success();
      throw err;
    }
    const result = await waitLoginResult(page, els, blazor);

    if (result === 'home') return success();
    if (result === 'invalid') {
      throw new Error('Login rejected: Username or Password is invalid (check data/users.csv)');
    }
    if (attempt < LOGIN_ATTEMPTS && RETRY_REASONS[result]) {
      const reason = RETRY_REASONS[result];
      console.warn(`[LOGIN_RETRY] vu=${vuId} user=${user.username} attempt=${attempt}: ${reason}, retrying`);
      events.emit('counter', 'kmqr.login_retry', 1);
      live('retry', { vu: vuId, reason });
      continue;
    }
    const why = RETRY_REASONS[result] || `not finished within ${LOGIN_WAIT}s`;
    throw new Error(`Login failed after ${attempt} attempt(s) (${why})`);
  }
}

/** Buka grup sidebar kalau masih tertutup. Toggle diklik saat sudah terbuka justru menutupnya. */
async function openMenuGroup(page, name) {
  const toggle = page.getByRole('button', { name });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await page.waitForTimeout(500);
  }
}

async function expandMenus(page) {
  for (const name of MENU_TOGGLES) {
    await openMenuGroup(page, name);
  }
}

async function openModule(page, mod) {
  await openMenuGroup(page, mod.group);
  await page.getByRole('link', { name: mod.name, exact: true }).click();

  await page.waitForURL(`**${mod.path}`);
  await page.getByRole('heading', { name: mod.heading, exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction((sel) => !document.querySelector(sel), LOADING_SELECTOR);
}

/** Pilih opsi di dropdown MudBlazor berdasarkan label filter (SBU, Site, Year, Month, Type). */
async function selectFilter(page, label, option) {
  const control = page.locator('.mud-input-control').filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) }).first();
  await control.click();
  await page.locator('.mud-popover-open .mud-list-item').filter({ hasText: new RegExp(`^\\s*${option}\\s*$`) }).first().click();
  await page.waitForTimeout(500);
}

/** Isi filter metrics secara acak dari kombinasi yang berisi data. Urutan penting: Year mengubah daftar Site. */
async function fillMetricsFilters(page, f) {
  const chosen = { year: randomOf(f.years), site: randomOf(f.sites), month: f.months ? randomOf(f.months) : null };
  if (chosen.year !== '2026') await selectFilter(page, 'Year', chosen.year); // 2026 sudah default
  await selectFilter(page, 'SBU', f.sbu);
  await selectFilter(page, 'Site', chosen.site); // daftar Site dimuat setelah SBU dipilih; click() menunggu opsinya muncul
  if (chosen.month) await selectFilter(page, 'Month', chosen.month);
  await selectFilter(page, 'Type', f.type);
  return chosen;
}

/**
 * Klik REFRESH lalu tunggu tabel selesai dimuat dan berisi data.
 * Gagal kalau muncul snackbar "saved" (Refresh tidak boleh membuat/mengubah data) atau validasi filter.
 */
async function refreshMetrics(page) {
  await page.getByRole('button', { name: 'REFRESH' }).click();
  await page.waitForFunction((sel) => {
    const snack = [...document.querySelectorAll('.mud-snackbar')].map((s) => s.innerText).join(' ');
    if (/saved|please select/i.test(snack)) return true;
    return !document.querySelector(sel) && document.querySelectorAll('.mud-table tbody tr').length > 0;
  }, LOADING_SELECTOR);
  const snack = (await page.locator('.mud-snackbar').allInnerTexts()).join(' ').trim();
  if (/saved/i.test(snack)) throw new Error(`REFRESH unexpectedly saved data: "${snack}"`);
  if (/please select/i.test(snack)) throw new Error(`Filter incomplete: "${snack}"`);
}

async function logout(page) {
  await page.locator('.mud-avatar button').first().click(); // ikon user kanan atas
  await page.locator('.mud-menu-item', { hasText: 'Logout' }).click();
  // Tunggu form login, bukan URL: navigasi logout bisa di-redirect sehingga waitForURL gagal (ERR_ABORTED)
  await page.getByRole('textbox', { name: 'Username*' }).waitFor({ state: 'visible' });
}

async function screenshot(page, vuId, step) {
  const file = `${Date.now()}-${vuId}-${step}.png`;
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, file) });
    return file;
  } catch (_) {
    return null; // abaikan kalau screenshot gagal
  }
}

/**
 * Pantau sinyal Blazor di browser VU: circuit dimatikan server (exception tak tertangani di server,
 * mis. ObjectDisposedException) atau koneksi terputus. Kalau ini terjadi, UI membeku dan klik berikutnya timeout.
 */
function trackBlazorHealth(page) {
  const health = { circuitTerminated: null, disconnected: null, errors: [] };
  const note = (text) => {
    const at = new Date().toISOString();
    if (/unhandled exception on the current circuit|circuit will be terminated/i.test(text)) health.circuitTerminated = health.circuitTerminated || at;
    if (/connection disconnected|websocket closed|connection being closed/i.test(text)) health.disconnected = health.disconnected || at;
    health.errors.push(`${at.slice(11, 19)} ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (health.errors.length > 5) health.errors.shift();
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') note(msg.text());
  });
  page.on('pageerror', (err) => note(err.message));
  return health;
}

// Detail VU yang gagal, satu JSON per baris (dibaca report.js). Path diset oleh run.js.
function recordFailure(record) {
  const file = process.env.KMQR_FAILURES_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (_) {
    /* abaikan kalau gagal menulis */
  }
}

/**
 * Fungsi yang dipanggil Artillery untuk setiap VU (lihat testFunction di kmqr.yml).
 * - test.step(nama, fn) otomatis tercatat sebagai metrik browser.step.<nama>
 * - events.emit('histogram' | 'counter', ...) untuk metrik custom
 */
async function kmqrJourney(page, vuContext, events, test) {
  const user = { username: vuContext.vars.username, password: vuContext.vars.password };
  const vuId = String(vuContext.vars.$uuid || '').slice(0, 8);
  const sessionStart = Date.now();

  // Setiap VU butuh ±150 MB RAM. Kalau RAM bebas sudah tipis, jangan tambah beban di laptop:
  // VU dicatat gagal (kmqr.skipped_low_ram) supaya terlihat bahwa test tidak berjalan sesuai rencana.
  const freeMb = Math.round(os.freemem() / 1048576);
  if (MIN_FREE_RAM_MB && freeMb < MIN_FREE_RAM_MB) {
    events.emit('counter', 'kmqr.skipped_low_ram', 1);
    live('vu_skip', { vu: vuId, freeMb });
    console.warn(`[SKIPPED_LOW_RAM] vu=${vuId} free=${freeMb}MB min=${MIN_FREE_RAM_MB}MB`);
    throw new Error('Skipped: laptop free RAM below MIN_FREE_RAM_MB'); // pesan tetap supaya tercatat sebagai 1 jenis error
  }

  const blazor = trackBlazorEvents(page);
  const health = trackBlazorHealth(page);
  let step = 'open_login_page';
  live('vu_start', { vu: vuId });

  try {
    let start = Date.now();
    await test.step('open_login_page', async () => {
      await page.goto('/'); // relatif terhadap config.target
      // "/" di-redirect Blazor ke /Auth/Login; isi form sebelum redirect selesai akan hilang
      await page.waitForURL(/\/Auth\/Login/);
      await page.getByRole('textbox', { name: 'Username*' }).waitFor({ state: 'visible' });
      await page.waitForLoadState('networkidle');
    });
    live('step', { vu: vuId, name: 'open_login_page', ms: Date.now() - start });

    step = 'login';
    await test.step('login', () => login(page, user, events, vuId, blazor));
    await think(page);

    step = 'expand_menu';
    await expandMenus(page);

    for (const mod of pickModules(MODULE_CLICKS)) {
      step = `module_${slug(mod.name)}`;
      start = Date.now();
      await test.step(step, () => openModule(page, mod));
      const ms = Date.now() - start;
      events.emit('histogram', 'kmqr.module_load', ms);
      live('step', { vu: vuId, name: 'module', module: mod.name, ms });
      await think(page);

      if (mod.filters) {
        step = `filter_${slug(mod.name)}`;
        await fillMetricsFilters(page, mod.filters);

        step = `refresh_${slug(mod.name)}`;
        start = Date.now();
        await test.step(step, () => refreshMetrics(page));
        const refreshMs = Date.now() - start;
        events.emit('histogram', 'kmqr.metrics_refresh', refreshMs);
        live('step', { vu: vuId, name: 'refresh', module: mod.name, ms: refreshMs });
        await think(page);
      }
    }
  } catch (err) {
    const error = err.message.split('\n')[0];
    const failedAt = new Date();
    const cause = health.circuitTerminated ? 'circuit Blazor dimatikan server (exception di server)'
      : health.disconnected ? 'koneksi Blazor terputus' : null;
    console.error(`[JOURNEY_FAILED] time=${failedAt.toISOString()} vu=${vuId} user=${user.username} step=${step} error=${error}${cause ? ` cause=${cause}` : ''}`);
    events.emit('counter', `kmqr.failed_step.${step}`, 1);
    if (health.circuitTerminated) events.emit('counter', 'kmqr.circuit_terminated', 1);
    live('vu_fail', { vu: vuId, step, error: cause ? `${error} (${cause})` : error });
    const shot = await screenshot(page, vuId, step);
    recordFailure({
      time: failedAt.getTime(),
      vu: vuId,
      user: user.username,
      step,
      error,
      cause,
      circuitTerminatedAt: health.circuitTerminated,
      disconnectedAt: health.disconnected,
      url: page.url(),
      sessionSeconds: Math.round((failedAt - sessionStart) / 1000),
      consoleErrors: health.errors,
      screenshot: shot,
    });
    throw err; // supaya Artillery mencatat VU ini sebagai gagal (vusers.failed)
  }

  try {
    await logout(page);
  } catch (err) {
    console.warn(`[LOGOUT_FAILED] vu=${vuId} error=${err.message.split('\n')[0]}`);
    events.emit('counter', 'kmqr.logout_failed', 1);
    live('logout_fail', { vu: vuId });
  }
  live('vu_done', { vu: vuId, ms: Date.now() - sessionStart });
}

module.exports = { kmqrJourney };
