/**
 * ระบบคำนวณค่าโดยสาร — TIH Phangan
 * คำนวณระยะทางขับรถจริงจาก Google Maps (Maps service ในตัว Apps Script — ฟรี ไม่ต้องเปิด billing)
 * แล้วคิดค่าโดยสารตามสูตรขั้นบันได + ค่าผู้โดยสารเพิ่ม
 *
 * อัปเดต:
 *  - บันทึกลงชีตได้ทั้งแบบ standalone และ bound ผ่าน CONFIG.SHEET_ID
 *  - ตัวเลือก AUTO_LOG เพื่อบันทึกอัตโนมัติทุกครั้งที่คำนวณสำเร็จ
 */

// ===== ตั้งค่าได้ที่นี่ =====
var CONFIG = {
  // ต้นทาง = โรงพยาบาล (ตายตัว)
  // แนะนำ: ใส่พิกัดที่ ORIGIN_LATLNG เพื่อความแม่นยำสูงสุด (เปิด Google Maps > คลิกขวาที่ รพ. > คัดลอกพิกัด)
  ORIGIN: 'Thai International Hospital Phangan, Koh Phangan, Surat Thani',
  ORIGIN_LATLNG: '',            // เช่น '9.7345,100.0212' — ถ้าใส่ จะใช้พิกัดนี้แทนชื่อ

  FIRST_TIER_KM: 10,            // 10 กม. แรก
  FIRST_TIER_RATE: 50,         // 50 บาท/กม. สำหรับ 10 กม. แรก
  SECOND_TIER_RATE: 60,        // 60 บาท/กม. สำหรับ กม. ถัดไป
  PER_PASSENGER_PCT: 0.10,     // +10% ต่อผู้โดยสารที่เพิ่มจากคนแรก
  ROUND_TO: 50,                // ปัดค่าโดยสารสุดท้ายเข้าใกล้ที่สุดทีละ 50 บาท
  REGION: 'th',

  // ===== Google Sheet (สำหรับบันทึกประวัติ) =====
  // วาง Spreadsheet ID จาก URL ของชีต:  https://docs.google.com/spreadsheets/d/<ใส่ตรงนี้>/edit
  // ถ้าใส่ค่านี้ จะบันทึกได้แม้ deploy เป็น Web App แบบ standalone
  // ถ้าเว้นว่าง จะใช้ชีตที่ผูกกับสคริปต์ (ต้องเปิดจาก ส่วนขยาย > Apps Script ในตัวชีต)
  SHEET_ID: '',

  AUTO_LOG: false,             // true = บันทึกอัตโนมัติทุกครั้งที่คำนวณสำเร็จ (ไม่ต้องกดปุ่ม)

  // ===== Telegram (สำหรับปุ่ม "ส่งงานให้คนขับ") =====
  // ใช้บอทตัวเดิม + กลุ่มเดิมกับระบบขอใช้รถ (CarRequests)
  TELEGRAM_TOKEN: '8434376409:AAFxRO-QsJGcMUvwL4aR-lvFOoCc6PC8mR8',
  TELEGRAM_CHAT_ID: '-1003314580906'
};
// ===========================

var LOG_SHEET_NAME = 'ประวัติค่าโดยสาร'; // ชื่อแท็บเก็บประวัติ — สร้างอัตโนมัติครั้งแรกที่กดบันทึก

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('คำนวณค่าโดยสาร — TIH Phangan')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * คำนวณค่าโดยสารจากชื่อปลายทาง + จำนวนผู้โดยสาร
 * เรียกจากหน้าเว็บผ่าน google.script.run
 */
function calculateFare(destination, passengers) {
  destination = (destination || '').toString().trim();
  passengers = parseInt(passengers, 10);
  if (!destination) return { ok: false, error: 'กรุณาวางพิกัดหรือลิงก์จาก Google Maps' };
  if (!passengers || passengers < 1) passengers = 1;

  // 1) อ่านพิกัดปลายทาง — รองรับ "lat, lng" หรือ ลิงก์ Google Maps (รวมลิงก์ย่อ goo.gl)
  var destLat, destLng, formatted;
  var pt = extractLatLng_(destination);

  if (pt) {
    destLat = pt.lat;
    destLng = pt.lng;
    // reverse geocode เพื่อโชว์ที่อยู่ให้พนักงานตรวจ (ถ้าทำไม่ได้ก็โชว์เป็นพิกัด)
    try {
      var rev = Maps.newGeocoder().reverseGeocode(destLat, destLng);
      formatted = (rev.status === 'OK' && rev.results[0])
        ? rev.results[0].formatted_address
        : (destLat.toFixed(5) + ', ' + destLng.toFixed(5));
    } catch (e) {
      formatted = destLat.toFixed(5) + ', ' + destLng.toFixed(5);
    }
  } else {
    // สำรอง: ถ้าไม่ใช่พิกัด/ลิงก์ ลองตีความเป็นชื่อสถานที่ (อาจคลาดเคลื่อนได้)
    var geo = Maps.newGeocoder().setRegion(CONFIG.REGION).geocode(destination);
    if (geo.status !== 'OK' || !geo.results || geo.results.length === 0) {
      return { ok: false, error: 'อ่านพิกัดไม่ได้ — กรุณาคัดลอกพิกัด (เช่น 9.7321, 100.0345) หรือลิงก์จาก Google Maps มาวาง' };
    }
    destLat = geo.results[0].geometry.location.lat;
    destLng = geo.results[0].geometry.location.lng;
    formatted = geo.results[0].formatted_address;
  }

  // 2) หาเส้นทางขับรถจริงจากต้นทาง (รพ.) ไปปลายทาง
  var finder = Maps.newDirectionFinder().setMode(Maps.DirectionFinder.Mode.DRIVING);
  if (CONFIG.ORIGIN_LATLNG) {
    var p = CONFIG.ORIGIN_LATLNG.split(',');
    finder.setOrigin(parseFloat(p[0]), parseFloat(p[1]));
  } else {
    finder.setOrigin(CONFIG.ORIGIN);
  }
  finder.setDestination(destLat, destLng);

  var dir;
  try {
    dir = finder.getDirections();
  } catch (e) {
    return { ok: false, error: 'เกิดข้อผิดพลาดในการหาเส้นทาง: ' + e.message };
  }
  if (!dir.routes || dir.routes.length === 0) {
    return { ok: false, error: 'หาเส้นทางขับรถไปสถานที่นี้ไม่ได้ (อาจเป็นเกาะ/พื้นที่ที่รถเข้าไม่ถึง)' };
  }

  var meters = dir.routes[0].legs[0].distance.value;
  var km = meters / 1000;

  // 3) คิดค่าโดยสาร
  var fare = computeFare(km, passengers);

  // ลิงก์เปิดดูเส้นทางบน Google Maps เพื่อให้พนักงานตรวจสอบ
  var originParam = CONFIG.ORIGIN_LATLNG || CONFIG.ORIGIN;
  var mapUrl = 'https://www.google.com/maps/dir/?api=1'
    + '&origin=' + encodeURIComponent(originParam)
    + '&destination=' + destLat + ',' + destLng
    + '&travelmode=driving';

  var result = {
    ok: true,
    destinationInput: destination,
    formattedAddress: formatted,
    lat: destLat,
    lng: destLng,
    km: km,
    passengers: passengers,
    tier1: fare.tier1,
    tier2: fare.tier2,
    base: fare.base,
    surchargePct: fare.surchargePct,
    raw: fare.raw,
    rounded: fare.rounded,
    mapUrl: mapUrl
  };

  // 4) บันทึกอัตโนมัติ (ถ้าเปิด AUTO_LOG) — ไม่ให้ error การบันทึกไปกระทบผลคำนวณ
  if (CONFIG.AUTO_LOG) {
    try {
      var logRes = logFare(result);
      result.logged = !!(logRes && logRes.ok);
      if (logRes && !logRes.ok) result.logWarning = logRes.error;
    } catch (e) {
      result.logged = false;
      result.logWarning = 'บันทึกอัตโนมัติไม่สำเร็จ: ' + e.message;
    }
  }

  return result;
}

/**
 * ตรรกะค่าโดยสารล้วน ๆ (แยกออกมาเพื่อทดสอบง่าย)
 */
function computeFare(km, passengers) {
  var tier1, tier2;
  if (km <= CONFIG.FIRST_TIER_KM) {
    tier1 = km * CONFIG.FIRST_TIER_RATE;
    tier2 = 0;
  } else {
    tier1 = CONFIG.FIRST_TIER_KM * CONFIG.FIRST_TIER_RATE;
    tier2 = (km - CONFIG.FIRST_TIER_KM) * CONFIG.SECOND_TIER_RATE;
  }
  var base = tier1 + tier2;                                   // ราคาฐาน (ผู้โดยสาร 1 คน)
  var surchargePct = CONFIG.PER_PASSENGER_PCT * (passengers - 1); // +10% ต่อคนเพิ่ม
  var raw = base * (1 + surchargePct);
  var rounded = Math.round(raw / CONFIG.ROUND_TO) * CONFIG.ROUND_TO; // ปัดทีละ 50
  return { tier1: tier1, tier2: tier2, base: base, surchargePct: surchargePct, raw: raw, rounded: rounded };
}

/**
 * อ่านพิกัดจากสิ่งที่พนักงานวางเข้ามา:
 *  - "9.7321, 100.0345" (คัดลอกพิกัดจาก Google Maps)
 *  - ลิงก์ Google Maps แบบเต็ม (มี @lat,lng หรือ ?q=lat,lng ฯลฯ)
 *  - ลิงก์ย่อ maps.app.goo.gl / goo.gl/maps (จะตามไปหาลิงก์เต็มให้)
 * คืนค่า { lat, lng } หรือ null ถ้าอ่านไม่ได้
 */
function extractLatLng_(input) {
  input = (input || '').toString().trim();
  if (!input) return null;

  // 1) พิกัดตรง ๆ "lat, lng"
  var direct = input.match(/^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  if (direct) return { lat: parseFloat(direct[1]), lng: parseFloat(direct[2]) };

  // 2) ลิงก์
  if (/^https?:\/\//i.test(input)) {
    var url = input;
    if (/goo\.gl|maps\.app\.goo\.gl/i.test(url)) {
      url = resolveRedirect_(url) || url; // คลายลิงก์ย่อ
    }
    var fromUrl = parseLatLngFromUrl_(url);
    if (fromUrl) return fromUrl;
  }
  return null;
}

function parseLatLngFromUrl_(url) {
  var m;
  // จุดสถานที่จริง (แม่นสุด)
  m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // จุดที่ระบุชัดใน query
  m = url.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // จุดกึ่งกลางจอ (สำรอง)
  m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  m = url.match(/[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return null;
}

/** ตามลิงก์ย่อไปจนเจอลิงก์เต็ม (สูงสุด 3 ทอด) */
function resolveRedirect_(url) {
  try {
    for (var i = 0; i < 3; i++) {
      var resp = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      if (code >= 300 && code < 400) {
        var loc = resp.getHeaders()['Location'] || resp.getHeaders()['location'];
        if (!loc) break;
        url = loc;
        if (parseLatLngFromUrl_(url)) return url; // เจอพิกัดแล้ว หยุด
      } else {
        break;
      }
    }
    return url;
  } catch (e) {
    return null;
  }
}

/**
 * เปิด Spreadsheet ที่จะใช้บันทึกประวัติ
 * ลำดับความสำคัญ: CONFIG.SHEET_ID -> ชีตที่ผูกกับสคริปต์ (getActiveSpreadsheet)
 * คืน null ถ้าหาไม่ได้
 */
function getTargetSpreadsheet_() {
  if (CONFIG.SHEET_ID) {
    try {
      return SpreadsheetApp.openById(CONFIG.SHEET_ID);
    } catch (e) {
      throw new Error('เปิดชีตจาก SHEET_ID ไม่ได้ (ตรวจ ID และสิทธิ์เข้าถึง): ' + e.message);
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet(); // อาจเป็น null ถ้า standalone
}

/**
 * บันทึกรายการค่าโดยสารลง Google Sheet
 * เรียกได้จากปุ่ม "บันทึกลงประวัติ" หรืออัตโนมัติเมื่อ CONFIG.AUTO_LOG = true
 */
function logFare(record) {
  try {
    if (!record) return { ok: false, error: 'ไม่มีข้อมูลให้บันทึก' };

    var ss = getTargetSpreadsheet_();
    if (!ss) {
      return {
        ok: false,
        error: 'บันทึกประวัติไม่ได้: สคริปต์ไม่ได้ผูกกับชีต และยังไม่ได้ตั้งค่า CONFIG.SHEET_ID — ' +
               'ให้ใส่ Spreadsheet ID ใน CONFIG.SHEET_ID'
      };
    }

    var sheet = getOrCreateLogSheet_(ss);

    var email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}

    sheet.appendRow([
      new Date(),
      record.destinationInput || '',
      record.formattedAddress || '',
      Number(record.km) || 0,
      Number(record.passengers) || 1,
      Number(record.base) || 0,
      Number(record.raw) || 0,
      Number(record.rounded) || 0,
      email
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message };
  }
}

/** หาแท็บประวัติ ถ้ายังไม่มีให้สร้างพร้อมหัวตารางและรูปแบบ */
function getOrCreateLogSheet_(ss) {
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(LOG_SHEET_NAME);
  sheet.appendRow([
    'วันที่-เวลา', 'ปลายทาง', 'ที่อยู่ที่ระบบหาเจอ', 'ระยะทาง (กม.)',
    'ผู้โดยสาร (คน)', 'ราคาฐาน (บาท)', 'รวมก่อนปัด (บาท)', 'ค่าโดยสารสุทธิ (บาท)', 'ผู้บันทึก'
  ]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 9).setFontWeight('bold').setBackground('#115E59').setFontColor('#FFFFFF');
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd  hh:mm');
  sheet.getRange('D:D').setNumberFormat('0.00');
  sheet.getRange('F:H').setNumberFormat('#,##0');
  sheet.setColumnWidth(1, 145);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(3, 260);
  return sheet;
}

/************** ส่งงานให้คนขับผ่าน Telegram (กลุ่มเดิม + บอทเดิม) **************/

// เรียกจากปุ่ม "ส่งงานให้คนขับ" บนหน้าเว็บ
// job = { passengers, formattedAddress, lat, lng }
function dispatchToDriver(job) {
  try {
    if (!CONFIG.TELEGRAM_TOKEN || CONFIG.TELEGRAM_TOKEN.indexOf('วาง_') === 0) {
      return { ok: false, error: 'ยังไม่ได้ตั้งค่า Telegram Token ใน CONFIG' };
    }
    if (!job || !job.lat || !job.lng) {
      return { ok: false, error: 'ไม่มีพิกัดปลายทาง — กรุณาคำนวณใหม่ก่อนส่ง' };
    }

    var navUrl = 'https://www.google.com/maps/dir/?api=1&destination='
      + job.lat + ',' + job.lng + '&travelmode=driving';

    var text =
      '🚖 มีงานส่งผู้โดยสาร\n' +
      '-------------------------\n' +
      'จำนวนผู้โดยสาร: ' + (job.passengers || 1) + ' คน\n' +
      'สถานที่: ' + (job.formattedAddress || '-') + '\n' +
      '📍 นำทาง: ' + navUrl;

    sendTelegramMessage_(text);          // ข้อความสรุปงาน
    sendTelegramLocation_(job.lat, job.lng); // หมุดตำแหน่งจริง (แตะแล้วนำทางได้)

    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'ส่งไม่สำเร็จ: ' + e.message };
  }
}

function sendTelegramMessage_(text) {
  var url = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/sendMessage';
  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: text },
    muteHttpExceptions: true
  });
}

function sendTelegramLocation_(lat, lng) {
  var url = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/sendLocation';
  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: CONFIG.TELEGRAM_CHAT_ID, latitude: lat, longitude: lng },
    muteHttpExceptions: true
  });
}

/**
 * ทดสอบสูตรเร็ว ๆ ใน editor (กด Run แล้วดู Log)
 * 15 กม. 3 คน -> ฐาน 800, +20%, = 960 -> ปัด 950
 */
function _test() {
  Logger.log(computeFare(15, 3));   // { base: 800, raw: 960, rounded: 950, ... }
  Logger.log(computeFare(12.4, 1)); // { base: 644, raw: 644, rounded: 650, ... }
  Logger.log(computeFare(8, 2));    // { base: 400, raw: 440, rounded: 450, ... }
}

/**
 * ทดสอบการบันทึกลงชีตเร็ว ๆ (กด Run แล้วไปดูแท็บ "ประวัติค่าโดยสาร")
 */
function _testLog() {
  var res = logFare({
    destinationInput: 'ทดสอบระบบ',
    formattedAddress: 'จุดทดสอบ เกาะพะงัน',
    km: 12.5,
    passengers: 2,
    base: 650,
    raw: 715,
    rounded: 700
  });
  Logger.log(res);
}
