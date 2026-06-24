/* Service Worker — TIH Taxi PWA Launcher
 * จำเป็นต้องมี เพื่อให้ Chrome (Android) เด้งปุ่ม "ติดตั้งแอป"
 * เก็บแคชเฉพาะหน้า Landing — ไม่แคชหน้า Apps Script (/exec) เพื่อให้ได้ข้อมูลล่าสุดเสมอ
 */
var CACHE = 'tih-taxi-v1';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS).catch(function () { /* เผื่อบางไฟล์ยังไม่มี ก็ข้ามไป */ });
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = e.request.url;
  // อย่าแคช Apps Script หรือโดเมน Google — ปล่อยให้วิ่งเน็ตตรงเสมอ
  if (url.indexOf('script.google.com') !== -1 ||
      url.indexOf('googleusercontent.com') !== -1 ||
      url.indexOf('google.com') !== -1) {
    return; // ใช้พฤติกรรม network ปกติ
  }
  // ไฟล์ Landing: ลองเน็ตก่อน ถ้าออฟไลน์ค่อยใช้แคช
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
