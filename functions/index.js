const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();

const TELEGRAM_TOKEN = "8467331852:AAGgHjmRfmiX6wcx_JATti9BoyUa7XOI-Gs";
const TELEGRAM_CHAT_ID = "7931893676";

// ===========================
// ÖĞRETMEN OLUŞTUR
// ===========================
exports.ogretmenOlustur = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş yapılmamış.");
  }

  const callerDoc = await admin.firestore()
    .collection("users")
    .doc(request.auth.uid)
    .get();

  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const { ad, brans, email, sifre } = request.data;

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password: sifre,
      displayName: ad
    });

    const uid = userRecord.uid;

    await admin.firestore().collection("teachers").add({
      uid, ad, brans, email,
      telegram_id: "",
      notification_enabled: true,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await admin.firestore().collection("users").doc(uid).set({
      ad, email,
      rol: "ogretmen",
      bildirim_aktif: false
    });

    return { success: true, uid };

  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// BUGÜNÜN DERSLERİNİ OLUŞTUR
// Her sabah 06:00'da çalışır
// ===========================
exports.bugunDersleriniOlustur = onSchedule("0 6 * * *", async (event) => {
  const db = admin.firestore();

  const bugun = new Date();
  const gunler = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];
  const bugunAdi = gunler[bugun.getDay()];
  const tarih = bugun.toISOString().split("T")[0];

  // Hafta sonu ise çalışma
  if (bugunAdi === "cumartesi" || bugunAdi === "pazar") {
    console.log("Hafta sonu, ders oluşturulmadı.");
    return;
  }

  // Bugün zaten oluşturulmuş mu kontrol et
  const mevcutSnap = await db.collection("today_lessons")
    .where("date", "==", tarih)
    .get();

  if (!mevcutSnap.empty) {
    console.log("Bugünün dersleri zaten oluşturulmuş.");
    return;
  }

  // Ders programından bugünün derslerini al
  const programSnap = await db.collection("schedule")
    .where("day", "==", bugunAdi)
    .get();

  if (programSnap.empty) {
    console.log("Bugün için ders programı yok.");
    return;
  }

  const batch = db.batch();

  programSnap.forEach(doc => {
    const ders = doc.data();
    const yeniRef = db.collection("today_lessons").doc();
    batch.set(yeniRef, {
      date: tarih,
      class_id: ders.class_id,
      lesson_number: ders.lesson_number,
      lesson_name: ders.lesson_name,
      teacher_id: ders.teacher_id,
      status: "pending",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  await batch.commit();
  console.log(`${tarih} için ${programSnap.size} ders oluşturuldu.`);
});

// ===========================
// GÜN SONU KONTROL
// Her gün 16:00'da çalışır
// ===========================
exports.gunSonuKontrol = onSchedule("0 16 * * 1-5", async (event) => {
  const db = admin.firestore();

  const bugun = new Date().toISOString().split("T")[0];

  // Eksik yoklamaları bul
  const eksikSnap = await db.collection("today_lessons")
    .where("date", "==", bugun)
    .where("status", "==", "pending")
    .get();

  // Devamsızlık hesapla
  const yoklamaSnap = await db.collection("attendance")
    .where("date", "==", bugun)
    .get();

  // Sınıf bazında yoklama sayısını hesapla
  const sinifYoklamaSayisi = {};
  const sinifToplamDers = {};

  // today_lessons'dan toplam ders sayısını al
  const todaySnap = await db.collection("today_lessons")
    .where("date", "==", bugun)
    .get();

  todaySnap.forEach(doc => {
    const d = doc.data();
    if (!sinifToplamDers[d.class_id]) sinifToplamDers[d.class_id] = 0;
    sinifToplamDers[d.class_id]++;
  });

  // Girilen yoklamaları say
  yoklamaSnap.forEach(doc => {
    const d = doc.data();
    if (!sinifYoklamaSayisi[d.class_id]) sinifYoklamaSayisi[d.class_id] = 0;
    sinifYoklamaSayisi[d.class_id]++;
  });

  // Tüm yoklamalar girilmiş sınıflar için devamsızlık hesapla
  for (const sinif of Object.keys(sinifToplamDers)) {
    const toplamDers = sinifToplamDers[sinif];
    const girilenDers = sinifYoklamaSayisi[sinif] || 0;

    // Eksik yoklama varsa hesaplama yapma
    if (girilenDers < toplamDers) continue;

    // Öğrenci bazında devamsızlık hesapla
    const ogrenciYokSayisi = {};

    yoklamaSnap.forEach(doc => {
      const d = doc.data();
      if (d.class_id !== sinif) return;
      (d.absent_students || []).forEach(ogrNo => {
        if (!ogrenciYokSayisi[ogrNo]) ogrenciYokSayisi[ogrNo] = 0;
        ogrenciYokSayisi[ogrNo]++;
      });
    });

    // Devamsızlık kaydı oluştur
    const batch = db.batch();
    for (const [ogrNo, yokSayisi] of Object.entries(ogrenciYokSayisi)) {
      const durum = yokSayisi >= toplamDers ? "full_day_absent" : "half_day_absent";
      const ref = db.collection("daily_summary").doc(`${bugun}_${sinif}_${ogrNo}`);
      batch.set(ref, {
        date: bugun,
        class_id: sinif,
        student_number: ogrNo,
        status: durum,
        absent_lesson_count: yokSayisi,
        total_lessons: toplamDers,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    await batch.commit();
  }

  // Telegram bildirimi için bildirim kuyruğuna ekle
  const eksikSinifler = [];
  eksikSnap.forEach(doc => eksikSinifler.push(doc.data().class_id));

  if (eksikSinifler.length > 0) {
    await db.collection("notification_queue").add({
      message: `⚠️ ${bugun} tarihinde eksik yoklama var!\nSınıflar: ${[...new Set(eksikSinifler)].join(", ")}`,
      recipient: "yonetim",
      status: "pending",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  console.log(`Gün sonu kontrol tamamlandı. Eksik yoklama: ${eksikSnap.size}`);
});

// ===========================
// MANUEL TODAY_LESSONS OLUŞTUR
// Admin panelinden tetiklenebilir
// ===========================
exports.manuelDersOlustur = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş yapılmamış.");
  }

  const callerDoc = await admin.firestore()
    .collection("users")
    .doc(request.auth.uid)
    .get();

  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const db = admin.firestore();
  const { tarih } = request.data;

  const bugunObj = new Date(tarih);
  const gunler = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];
  const bugunAdi = gunler[bugunObj.getDay()];

  // Mevcut kayıtları sil
  const mevcutSnap = await db.collection("today_lessons")
    .where("date", "==", tarih)
    .get();

  const deleteBatch = db.batch();
  mevcutSnap.forEach(doc => deleteBatch.delete(doc.ref));
  await deleteBatch.commit();

  // Yeni oluştur
  const programSnap = await db.collection("schedule")
    .where("day", "==", bugunAdi)
    .get();

  if (programSnap.empty) {
    return { success: false, message: "Bu gün için ders programı yok." };
  }

  const batch = db.batch();
  programSnap.forEach(doc => {
    const ders = doc.data();
    const yeniRef = db.collection("today_lessons").doc();
    batch.set(yeniRef, {
      date: tarih,
      class_id: ders.class_id,
      lesson_number: ders.lesson_number,
      lesson_name: ders.lesson_name,
      teacher_id: ders.teacher_id,
      status: "pending",
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  await batch.commit();
  return { success: true, message: `${programSnap.size} ders oluşturuldu.` };
});
// ===========================
// TELEGRAM BİLDİRİM GÖNDERİCİ
// ===========================
async function telegramMesajGonder(mesaj) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const https = require("https");
  
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mesaj,
      parse_mode: "HTML"
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve(JSON.parse(body)));
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ===========================
// BİLDİRİM KUYRUĞunu İŞLE
// Her 30 dakikada bir çalışır
// ===========================
exports.bildirimleriGonder = onSchedule("*/30 * * * *", async (event) => {
  const db = admin.firestore();

  const snap = await db.collection("notification_queue")
    .where("status", "==", "pending")
    .get();

  if (snap.empty) return;

  const batch = db.batch();

  for (const doc of snap.docs) {
    const bildirim = doc.data();
    try {
      await telegramMesajGonder(bildirim.message);
      batch.update(doc.ref, { status: "sent", sent_at: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
      console.error("Telegram hatası:", err);
      batch.update(doc.ref, { status: "error", error: err.message });
    }
  }

  await batch.commit();
  console.log(`${snap.size} bildirim gönderildi.`);
});

// ===========================
// TEST BİLDİRİMİ GÖNDER
// Admin panelinden tetiklenebilir
// ===========================
exports.testBildirimiGonder = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş yapılmamış.");
  }

  try {
    await telegramMesajGonder(
      "✅ <b>Okul Yoklama Sistemi</b>\n\nTest bildirimi başarıyla gönderildi!\nSistem aktif ve çalışıyor."
    );
    return { success: true };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});