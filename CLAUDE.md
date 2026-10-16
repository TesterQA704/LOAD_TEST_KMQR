# CLAUDE.md: konteks proyek Load Test KMQR

File ini adalah memori proyek untuk asisten AI (Claude versi apa pun) dan untuk manusia.
Claude Code membacanya otomatis; di claude.ai, upload atau tempel isinya di awal percakapan.
Cara pakai dan detail teknis lengkap ada di [README.md](README.md). File ini mencatat **status, temuan, dan keputusan** yang tidak terlihat dari kode.

Terakhir diperbarui: 16 Okt 2026.

## Ringkasan proyek

- Load test aplikasi **KMQR** (Blazor Server + MudBlazor, tanpa REST API) memakai **Artillery + engine Playwright**: setiap VU adalah browser sungguhan.
- Target: production `https://kmqr.kalbe.co.id` (default di `kmqr.yml`), staging `https://stg-kmqr.kalbe.co.id`.
- File inti: `kmqr.yml` (config & fase beban), `flows.js` (alur user), `run.js` (dashboard live + report), `report.js` (report HTML).
- Jalankan: `npm run smoke | debug | load | stress`, ganti target: `node run.js smoke -t https://stg-kmqr.kalbe.co.id`.
- Hasil tes formal (dokumen "Load Test KMQR - Result.pdf"): staging 13 Okt 2026, production 15 Okt 2026.

## Temuan utama (16 Okt 2026): bug script, bukan server

**Gejala:** banyak VU gagal dengan `locator.click: Timeout 30000ms exceeded` pada langkah `module_*`, bahkan di production 10 VU.

**Penyebab:** toggle grup sidebar terklik dua kali.
- Versi lama memanggil `expandMenus()` setelah login: klik "Toggle Metrics Detail" lalu "Toggle Dashboard Reporting", masing-masing jeda tetap 500 ms.
- Lalu `openMenuGroup()` membaca `aria-expanded`. Toggle Blazor adalah round-trip ke server; di production (SignalR **Long Polling**) jawabannya sering > 500 ms, jadi `aria-expanded` masih `"false"` dan script mengklik toggle **lagi**.
- Long Polling mengirim event yang tertahan dalam 1 POST, server memproses 2 toggle sekaligus dan me-render hasil bersihnya: grup **tertutup**, link modul tidak pernah muncul.
- Bukti: 143 dari 143 kegagalan `module_* locator.click` di semua run terjadi di URL `/` (modul pertama setelah `expandMenus`); screenshot menunjukkan grup tujuan tertutup.
- Staging (WebSocket, cepat) jarang terpicu, itu sebabnya staging lulus sampai 75 VU sedangkan production gagal sejak 10 VU.

**Akibatnya untuk laporan 15 Okt (production):**
- Kegagalan 10, 20, 50 VU hampir semuanya bug script ini. **Hasil itu tidak valid sebagai ukuran kapasitas server.**
- Kegagalan server yang asli baru di 75 VU, sekitar 14:26–14:28 WIB, menjelang pod `kf-asd-kfmonline-prod-...-fxpft` restart dengan **exit code 139** (pod CPU ±1.4 core, memori ±1.7 GiB).
- Catatan di dokumen "script salah menghitung retry sebagai failed" **tidak tepat**: hitungan failed benar, penyebabnya bug menu.

## Perbaikan yang sudah dibuat (16 Okt 2026, belum di-commit)

Di `flows.js`:
1. `expandMenus()` dan `MENU_TOGGLES` dihapus. `openMenuGroup(page, name, link, blazor, events)` membuka grup per modul hanya kalau link belum terlihat, lalu menunggu link muncul. Toggle **hanya diklik ulang kalau klik terbukti tidak terkirim** ke server (counter `kmqr.menu_retry`, maks `MENU_ATTEMPTS` = 3). Kalau klik terkirim tapi grup tidak terbuka dalam 30 s, gagal dengan pesan jelas (itu masalah server).
2. `selectFilter`: jeda tetap 500 ms diganti menunggu `.mud-popover-open .mud-list-item` hilang (dropdown ditutup server). Sebelumnya overlay dropdown (`.mud-overlay`) menghalangi klik filter berikutnya saat server lambat. Sengaja tidak menunggu semua `.mud-popover-open`, karena tooltip hover juga memakainya.
3. `open_login_page`: `page.waitForURL` diganti `waitForLoginUrl()` (polling `page.url()`), karena redirect ganda ke `/Auth/Login` memicu `net::ERR_ABORTED` palsu.
4. `trackBlazorEvents` sekarang juga mencatat POST `/_blazor` yang masih berjalan (`pending`). Helper `clickIgnored()` hanya menyatakan klik diabaikan kalau tidak ada event terkirim **dan** tidak ada kiriman yang antre (Long Polling menahan event selama POST sebelumnya belum dijawab). Dipakai di login dan menu.

Juga: `report.js` menampilkan `kmqr.menu_retry`; `README.md` diperbarui (alur menu & tabel metrik).
`kmqr.yml` punya perubahan `maxVusers` milik user sendiri (25/30/38): jangan diubah tanpa ditanya.

## Status verifikasi

| Tes | Hasil |
|---|---|
| Replika lokal, latency 100–1500 ms, 20 VU | lama: 4 gagal (pola sama dengan production); **baru: 0 gagal** |
| Replika, latency 300–3000 ms + sidebar accordion + 15% klik diabaikan | lama: 10 gagal; **baru: 0 gagal** (5× `menu_retry` berhasil) |
| Replika, latency 20–100 ms (mirip staging) | lama & baru: 0 gagal |
| **Production asli, smoke 1 VU** (16 Okt 09:45) | **PASSED**, 5 modul lintas grup, filter + REFRESH jalan |
| Staging asli, smoke | tidak bisa: akun ditolak "Username does not have access to this website." (masalah hak akses akun, bukan script) |

**Belum dilakukan:** stress test ulang di production dengan kode baru (10/20/50/75 VU). Lakukan sesuai jadwal bersama tim infra.

## Hal yang perlu diingat (gotcha)

- **Jaringan:** domain KMQR hanya resolve di jaringan Kalbe/VPN (DNS kantor `10.100.19.19`, IP server `10.100.19.73`). Di Wi-Fi lain (DNS 8.8.8.8) muncul `ENOTFOUND`; `run.js` berhenti dengan pesan DNS. Cek: `Resolve-DnsName kmqr.kalbe.co.id`.
- **Akun:** `data/users.csv` (tidak di-commit) hanya berisi **1 akun**, jadi semua VU login dengan akun yang sama. Kurang realistis untuk puluhan user; sebaiknya minta beberapa akun test. Akun ini sudah tidak punya akses ke staging per 16 Okt.
- **`maxErrorRate: 10`** di `kmqr.yml` artinya **maksimal 10% VU gagal**, bukan "< 10 error".
- **Production:** hanya aksi baca. REFRESH di Metrics Result Input membuat draft dokumen baru, maka di production disetel `'off'` (lihat `DATA_PROFILES` di `flows.js`).
- **Production memakai Long Polling** (proxy menolak WebSocket): setiap round-trip lebih lama dan event dikirim bertumpuk. Jangan pakai jeda tetap untuk menunggu hasil klik; selalu tunggu kondisi UI yang dihasilkan server.
- **RAM laptop:** ±0.5 GB + ±0.15 GB per VU bersamaan. Untuk 50/75 VU tes dijalankan dari 2 laptop.

## Replika lokal (folder `mock/`)

Untuk menguji perubahan `flows.js` tanpa akses ke KMQR. `mock/server.js` meniru perilaku Blazor yang relevan: setiap event = POST `/_blazor` dengan latency, kiriman di-batch seperti Long Polling, toggle sidebar benar-benar toggle, dropdown dengan overlay.

```bash
cd mock
# sekali saja: sertifikat self-signed (di-ignore git)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=stg-kmqr.kalbe.co.id"
# terminal 1: server replika (env opsional: LAT_MIN, LAT_MAX ms; ACCORDION=1; IGNORE_RATE=0.15)
LAT_MIN=100 LAT_MAX=1500 node server.js
# terminal 2: jalankan flows.js terhadap replika (ubah arrivalCount di mock.yml untuk jumlah VU)
THINK_MIN=1 THINK_MAX=2 MIN_FREE_RAM_MB=0 node ../node_modules/artillery/bin/run run mock.yml -e mock -o out.json
```

Di Git Bash Windows, ganti `-subj "/CN=..."` dengan `-subj "//CN=..."`.
Untuk membandingkan dengan kode lama: `git show 65caea7:flows.js > /tmp/x/flows.js`, salin `mock.yml` ke folder itu, lalu ubah `processor` dan path payload.
Replika bukan pengganti tes ke server asli; setelah mengubah `flows.js`, tetap jalankan `npm run smoke` di jaringan Kalbe.

## Langkah berikutnya

1. Commit perubahan (`flows.js`, `report.js`, `README.md`, `CLAUDE.md`, `mock/`, `.gitignore`) kalau user setuju.
2. Ulangi stress production 10/20/50/75 VU dengan kode baru; hasil lama 10–50 VU jangan dipakai sebagai kesimpulan.
3. Minta akses staging untuk akun test (atau akun lain) dan beberapa akun tambahan untuk `data/users.csv`.
4. Temuan untuk tim aplikasi/infra: pod production crash (exit 139) di ±75 VU; production memakai Long Polling, bukan WebSocket.
