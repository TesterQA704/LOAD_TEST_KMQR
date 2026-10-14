# KMQR Load Test (Artillery + Playwright)

Load test KMQR menggunakan [Artillery](https://www.artillery.io/docs) dengan engine **Playwright**.
KMQR adalah aplikasi Blazor Server (tanpa REST API), jadi setiap virtual user (VU) menjalankan browser sungguhan: login, membuka modul, lalu logout.
Locator diambil dari project Playwright `Automation_KMQR`.

## Struktur

```
Load_Test_KMQR/
├── kmqr.yml               # config: target, phases per environment, payload, threshold
├── flows.js               # alur user (Playwright): login → buka modul acak (+ refresh data metrics) → logout
├── run.js                 # menjalankan test dengan tampilan live ringkas di terminal
├── report.js              # membuat report HTML dari JSON hasil test
├── data/
│   ├── users.example.csv  # contoh format akun
│   └── users.csv          # akun test asli (tidak di-commit)
├── results/               # JSON, log mentah, report HTML, screenshot error
└── package.json           # npm scripts: smoke, debug, load, stress
```

## Persiapan (sekali saja)

```powershell
npm install
npx playwright install chromium
```

Lalu isi `data/users.csv` dengan akun test (baris pertama adalah header `username,password`).

## Menjalankan

```powershell
npm run debug    # 1 user, browser TERLIHAT: untuk mengecek locator
npm run smoke    # 1 user, headless
npm run load     # beban normal (±5 user bersamaan, ±7 menit)
npm run stress   # opsional: ±5 → ±10 → ±20 user (±9 menit)
```

Selama test berjalan, terminal menampilkan dashboard live (mirip k6): progress bar & fase, jumlah VU aktif/selesai/gagal, retry login, CPU/RAM laptop, tabel median/p95/max per langkah, dan recent events (retry, VU gagal).
Kalau CPU laptop ≥ 85%, baris `client` berwarna kuning: hasil yang lambat bisa jadi karena laptop, bukan server.
Di akhir tampil hasil `checks`, status **PASSED/FAILED**, lalu report HTML dibuat otomatis.
Output mentah Artillery tidak ditampilkan tapi disimpan di `results/kmqr_<env>_<waktu>.log`.

Hentikan kapan saja dengan **Ctrl+C** (tekan 2x untuk paksa berhenti).

Untuk melihat output mentah Artillery seperti dulu: `npm run raw -- -e smoke -o results`

Untuk mengubah perilaku alur tanpa edit kode, set environment variable sebelum menjalankan:

```powershell
$env:MODULE_CLICKS="3"; $env:THINK_MIN="2"; $env:THINK_MAX="5"; npm run smoke
```

| Variabel | Default | Keterangan |
|---|---|---|
| `MODULE_CLICKS` | `5` | Jumlah modul yang dibuka per sesi (minimal 1 di antaranya modul metrics) |
| `THINK_MIN` / `THINK_MAX` | `3` / `8` | Jeda antar langkah (detik) |
| `MIN_FREE_RAM_MB` | `700` | VU baru dilewati (tercatat `kmqr.skipped_low_ram`) kalau RAM bebas laptop di bawah ini. `0` = nonaktif |
| `LOGIN_ATTEMPTS` | `3` | Maksimal percobaan login |
| `LOGIN_SETTLE` | `1` | Detik memastikan isian form login tidak hilang sebelum klik Sign In |
| `LOGIN_WAIT` | `60` | Detik maksimal tunggu login yang sedang diproses server (tidak di-retry) |

Target URL bisa diganti tanpa edit file: `node run.js smoke -t https://url-lain`

### Login yang "terpental"

Kadang klik Sign In tidak membuat user masuk, karena form login belum benar-benar siap: Blazor me-render ulang form (isian hilang) atau handler klik belum terpasang. Ini lebih sering terjadi saat server sibuk.
Penanganannya di `flows.js`:

1. Setelah mengisi form, script memastikan isian bertahan `LOGIN_SETTLE` detik. Kalau hilang, form diisi ulang (counter `kmqr.login_form_reset`).
2. Setelah klik, script memantau WebSocket Blazor. Klik yang diproses selalu mengirim event ke server dalam < 100 ms.
   - Tidak ada event terkirim dan tidak ada navigasi dalam 2 detik: **klik diabaikan**, langsung diulang.
   - Form kosong ≥ 1 detik tanpa navigasi: **isian hilang**, langsung diulang.
   - Ada event atau navigasi: **login sedang diproses**, ditunggu sampai `LOGIN_WAIT` detik tanpa diulang.
3. Setiap pengulangan dihitung di counter `kmqr.login_retry` dan tampil di "recent events" pada terminal.

## Kebutuhan RAM laptop

Setiap VU adalah browser sungguhan. Hasil pengukuran di KMQR:

| | RAM |
|---|---|
| Browser + Node/Artillery | ±0.5 GB |
| Per VU bersamaan | ±0.15 GB |
| `load` (maks 10 VU) | ±2 GB |
| `stress` (maks 30 VU) | ±5 GB |

Sebelum `npm run stress`, pastikan RAM bebas **≥ 6 GB**:

1. Tutup aplikasi berat: Chrome, Discord, Teams/Outlook (proses `msedgewebview2`), overlay NVIDIA.
2. Tutup VS Code dan jalankan dari **Windows Terminal / PowerShell** biasa:
   ```powershell
   cd C:UserssamuelDesktopLoad_Test_KMQR-K6
   Get-CimInstance Win32_OperatingSystem | % { "{0:N1} GB bebas" -f ($_.FreePhysicalMemory/1MB) }
   npm run stress
   ```
3. Kalau di awal test muncul baris kuning `RAM: up to N VUs need ~X GB ...`, RAM belum cukup: tekan Ctrl+C dan bebaskan RAM lagi.

Selama test, baris `client` menampilkan RAM bebas. Kalau RAM bebas turun di bawah `MIN_FREE_RAM_MB`, VU baru **dilewati** (bukan dijalankan) supaya laptop tidak macet. VU yang dilewati dihitung gagal, jadi hasil test akan FAILED: itu tanda bebannya tidak berjalan sesuai rencana, bukan server yang gagal.

## Alur per VU

1. Buka halaman login, login (dengan retry, lihat di atas).
2. Buka `MODULE_CLICKS` modul acak dari 8 modul (tidak sama berturut-turut, **minimal 1 modul metrics**):
   - **Metrics** (Target Corporate, Target Site, Target Approval, Result Input, Result Review): buka halaman → pilih filter → **REFRESH** → tunggu tabel berisi data.
   - **Dashboard Reporting** (Picapa Sira, Audit Trail, Document List): hanya dibuka.
3. Logout.

Data test per environment ada di `DATA_PROFILES` di `flows.js`, dipilih otomatis dari domain `target` di `kmqr.yml`
(domain yang tidak terdaftar langsung ditolak). Nilai dipilih acak dari kombinasi yang berisi data:

| Environment | Halaman | SBU | Type | Year | Site | Month | REFRESH |
|---|---|---|---|---|---|---|---|
| Staging | Target Corporate / Site / Approval | TEST | Quality | 2026 | test / FinalTest | - | ya, tunggu data |
| Staging | Result Input / Review | TEST | Quality | 2027 | FinalTest | Jan–Dec | ya, tunggu data |
| Production | Target Corporate / Site / Approval | Tests | Quality | 2026 | FinalTest | - | ya, tunggu data |
| Production | Result Input | - | - | - | - | - | **tidak** (halaman hanya dibuka) |
| Production | Result Review | Tests | Quality | 2026 | FinalTest | Jan–Dec | ya, "Document not found" dihitung respons sah |

Production dicek 14 Okt 2026: satu-satunya data test adalah dokumen `KPI-CQA-Target-FinalTest-2026` (SBU Tests). Belum ada dokumen Result sama sekali, jadi Result Input tidak di-REFRESH.

> ⚠️ **REFRESH di Metrics Result Input membuat draft dokumen baru** kalau dokumen untuk Year/Site/Month itu belum ada.
> Hanya aktifkan REFRESH Result Input untuk kombinasi yang dokumennya sudah ada di Document List.
> Sebagai pengaman, VU langsung gagal (dan tercatat) kalau setelah REFRESH muncul snackbar "saved".

> ℹ️ **Production memakai Long Polling, bukan WebSocket**: proxy/ingress production menjawab handshake WebSocket dengan HTTP 200.
> Setiap user jadi mengirim jauh lebih banyak request (±57 vs 2 di staging per ±13 detik). Ini temuan untuk tim infra.
## Gagal karena server atau karena laptop?

Setiap 5 detik `run.js` merekam ke `results/<nama>.client.jsonl`:

- **Kondisi laptop**: CPU, RAM bebas, dan *lag* proses browser (seberapa terlambat laptop menjalankan perintah Playwright).
- **Probe server**: 1 request GET ringan ke halaman login, terpisah dari browser VU, untuk mengukur respons server secara independen.

Report membandingkan keduanya di bagian **"Validitas: laptop atau server?"** dan memberi label **Sisi** pada setiap VU yang gagal:

| Label | Artinya |
|---|---|
| Server | Ada sinyal server di jendela waktu kegagalan: circuit Blazor dimatikan server, HTTP 5xx, atau probe server lambat/error |
| Laptop | CPU laptop ≥ 90%, RAM bebas < 700 MB, atau lag ≥ 1 s, tanpa sinyal server |
| Keduanya | Ada sinyal server dan laptop sekaligus: perbaiki kondisi laptop lalu ulangi test |
| Kemungkinan aplikasi | Laptop sehat dan probe normal: masalah hanya di sesi user itu (mis. exception per circuit) |

Kalau report menyatakan **"Laptop tidak menjadi bottleneck"**, hasilnya valid sebagai ukuran server.
Untuk bukti dari sisi server, cocokkan jam kegagalan (kolom UTC) dengan log pod dan monitoring CPU/RAM pod/database dari tim infra.

## Konsep penting: model "arrival"

Berbeda dengan k6 (jumlah VU tetap dan berulang), di Artillery **setiap VU datang, menjalankan 1 sesi, lalu selesai**.
Beban diatur lewat laju kedatangan di `phases`:

```
user bersamaan ≈ laju kedatangan (user/detik) × durasi 1 sesi (detik)
```

Contoh fase `sustained` di `load`: `arrivalCount: 30` dalam `duration: 300` = 1 user tiap 10 detik.
Kalau 1 sesi ±50 detik, berarti ±5 user bersamaan.
Kalau server melambat, sesi jadi lebih lama dan jumlah user bersamaan ikut naik. `maxVusers` menjadi batas pengaman agar tidak berlebihan di production.

Ubah angka di `kmqr.yml` bagian `environments` untuk menyesuaikan beban.

## Membaca hasil

Ringkasan muncul di terminal, JSON lengkap dan report HTML tersimpan di `results/`.

| Metrik | Arti |
|---|---|
| `browser.step.open_login_page` | Waktu membuka halaman login |
| `kmqr.login` | Waktu dari klik Sign In sampai menu utama tampil (percobaan yang berhasil saja), dipakai untuk threshold |
| `browser.step.login` | Total langkah login termasuk cek isian form dan retry |
| `kmqr.login_retry` / `kmqr.login_form_reset` | Berapa kali login diulang / isian form hilang sebelum klik |
| `browser.step.module_<nama>` | Waktu buka modul tertentu sampai isinya tampil |
| `kmqr.module_load` | Gabungan waktu buka semua modul |
| `browser.step.refresh_<modul>` | Waktu klik REFRESH sampai tabel metrics berisi data, per modul |
| `kmqr.metrics_refresh` | Gabungan waktu refresh semua modul metrics (dipakai untuk threshold) |
| `browser.page.FCP` / `LCP` / `TTFB` | Web vitals halaman |
| `vusers.completed` / `vusers.failed` | Jumlah sesi berhasil / gagal |
| `kmqr.failed_step.<langkah>` | Langkah tempat sesi gagal |
| `errors.<pesan>` | Jenis error yang terjadi |
| `Checks: ok / fail` | Penentu test **lulus** (exit 0) atau **gagal** (exit 1) |

Kalau sesi gagal: lihat "recent events" di terminal atau cari `[JOURNEY_FAILED]` di file `.log` dan lihat screenshot di `results/screenshots/`.

### Report HTML

```powershell
npm run report                                  # dari JSON terbaru di results/
node report.js results/kmqr_load_xxx.json       # dari file tertentu
```

`npm run smoke/load/stress` sudah membuatnya otomatis. Hasilnya file `.html` dengan nama sama di `results/`, berisi ringkasan VU, tabel waktu per langkah, grafik (VU aktif, p95 per periode, TTFB) yang bisa di-hover untuk melihat nilai tiap titik, web vitals, dan error. File ini offline (tanpa CDN), jadi aman dibagikan.

> `artillery report` bawaan **sudah tidak didukung** di Artillery 2.x, jadi `npm run report` memakai `report.js`.
> Alternatif resminya Artillery Cloud (`--record --key <API_KEY>`), tapi itu mengirim hasil test ke layanan eksternal, jadi minta izin dulu sebelum dipakai untuk aplikasi internal.

## Catatan

- `plugins: ensure: {}` di `kmqr.yml` **wajib ada**. Tanpanya, threshold di bagian `ensure` diabaikan dan test selalu dianggap lulus.
- `phases` hanya boleh ditulis di dalam `environments`. Artillery menggabungkan array per indeks, jadi phase di level config akan tercampur.
- Semua VU berbagi satu proses Chromium (context terpisah per VU), sehingga lebih hemat RAM daripada k6 browser. Tetap pantau CPU laptop selama test.
- **Production**: hanya aksi baca, jalankan sesuai jadwal yang disepakati, dan pantau bersama tim infra.
