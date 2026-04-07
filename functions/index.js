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
exports.nobetTelegramGonder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const db = admin.firestore();
  const nobetDoc = await db.collection("nobet_ayarlar").doc("mevcut").get();
  if (!nobetDoc.exists) throw new HttpsError("not-found", "Nobet verisi bulunamadi.");

  const veri = nobetDoc.data();
  const noktalar = [
    "On Bahce 1", "On Bahce 2", "Arka Bahce", "Zemin Kat",
    "1. Kat Sag", "1. Kat Sol", "2. Kat Sag", "2. Kat Sol",
    "3. Kat Sag", "3. Kat Sol"
  ];

  const baslangic = new Date(veri.hafta_baslangic + 'T12:00:00');

  const formatTarih = (d) => {
    const gun = String(d.getDate()).padStart(2, '0');
    const ay = String(d.getMonth() + 1).padStart(2, '0');
    const yil = d.getFullYear();
    return `${gun}.${ay}.${yil}`;
  };

  let mesaj = `📋 *HAFTALIK NÖBET ÇİZELGESİ*\n`;
  mesaj += `------------------------------------------\n\n`;

  veri.gunler.forEach((g, gunIdx) => {
    const gunTarihi = new Date(baslangic);
    gunTarihi.setDate(baslangic.getDate() + gunIdx);
    mesaj += `🗓 *${formatTarih(gunTarihi)} ${g.gun}*\n`;
    mesaj += '`\n';
    noktalar.forEach((nokta, i) => {
      const noktaPad = nokta.padEnd(12, ' ');
      mesaj += `${noktaPad}: ${g.nobetciler[i] || '-'}\n`;
    });
    mesaj += '`\n\n';
  });

  await telegramMesajGonder(mesaj);
  return { success: true };
});
exports.haftalikNobetGonder = onSchedule("0 13 * * 5", async (event) => {
  const db = admin.firestore();
  const nobetDoc = await db.collection("nobet_ayarlar").doc("mevcut").get();
  if (!nobetDoc.exists) return;

  const veri = nobetDoc.data();
  const noktalar = [
    "On Bahce 1", "On Bahce 2", "Arka Bahce", "Zemin Kat",
    "1. Kat Sag", "1. Kat Sol", "2. Kat Sag", "2. Kat Sol",
    "3. Kat Sag", "3. Kat Sol"
  ];

  const baslangic = new Date(veri.hafta_baslangic + 'T12:00:00');
  const formatTarih = (d) => {
    const gun = String(d.getDate()).padStart(2, '0');
    const ay = String(d.getMonth() + 1).padStart(2, '0');
    return `${gun}.${ay}.${d.getFullYear()}`;
  };

  // Bir sonraki haftanın verilerini hesapla
  const sonrakiBaslangic = new Date(baslangic);
  sonrakiBaslangic.setDate(baslangic.getDate() + 7);

  let sonrakiGunler;
  if (veri.rotasyon_aktif) {
    sonrakiGunler = veri.gunler.map(gun => {
      const nobetciler = [...gun.nobetciler];
      const hareketli = nobetciler.filter(n => !n.includes('(S)'));
      if (hareketli.length > 1) hareketli.unshift(hareketli.pop());
      let idx = 0;
      const yeni = nobetciler.map(n => n.includes('(S)') ? n : hareketli[idx++]);
      return { ...gun, nobetciler: yeni };
    });
  } else {
    sonrakiGunler = veri.gunler;
  }

  const sonrakiBitis = new Date(sonrakiBaslangic);
  sonrakiBitis.setDate(sonrakiBaslangic.getDate() + 4);

  let mesaj = `📋 *HAFTALIK NÖBET ÇİZELGESİ*\n`;
  mesaj += `${formatTarih(sonrakiBaslangic)} - ${formatTarih(sonrakiBitis)}\n`;
  mesaj += `------------------------------------------\n\n`;

  sonrakiGunler.forEach((g, gunIdx) => {
    const gunTarihi = new Date(sonrakiBaslangic);
    gunTarihi.setDate(sonrakiBaslangic.getDate() + gunIdx);
    mesaj += `🗓 *${formatTarih(gunTarihi)} ${g.gun}*\n`;
    mesaj += '`\n';
    noktalar.forEach((nokta, i) => {
      const noktaPad = nokta.padEnd(12, ' ');
      mesaj += `${noktaPad}: ${g.nobetciler[i] || '-'}\n`;
    });
    mesaj += '`\n\n';
  });

  await telegramMesajGonder(mesaj);
});
exports.disiplinIlkKurulum = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");
  const db = admin.firestore();

  const turler = [
    { ad: "Derse gec kalma", esik: 3, sira: 1, aktif: true },
    { ad: "Ders materyallerini getirmeme", esik: 3, sira: 2, aktif: true },
    { ad: "Kilik kiyafet kuralina uymama", esik: 1, sira: 3, aktif: true },
    { ad: "Okul esyasina zarar verme", esik: 1, sira: 4, aktif: true },
    { ad: "Ogretmene saygisizlik", esik: 1, sira: 5, aktif: true },
    { ad: "Ders akisini bozma", esik: 2, sira: 6, aktif: true },
    { ad: "Okul kulturune uyumsuzluk", esik: 2, sira: 7, aktif: true }
  ];

  const batch = db.batch();
  turler.forEach(tur => {
    const ref = db.collection("disiplin_turleri").doc();
    batch.set(ref, { ...tur, olusturulma: admin.firestore.FieldValue.serverTimestamp() });
  });
  await batch.commit();

  return { success: true, message: "Disiplin turleri olusturuldu." };
});
exports.disiplinEsikKontrol = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const db = admin.firestore();
  const { donem } = request.data;

  // Davranış türlerini getir
  const turSnap = await db.collection("disiplin_turleri").where("aktif", "==", true).get();
  const turler = {};
  turSnap.forEach(d => turler[d.data().ad] = d.data().esik);

  // Bu dönemdeki kayıtları getir
  const kayitSnap = await db.collection("disiplin_kayitlar").where("donem", "==", donem).get();
  const sayimlar = {};
  kayitSnap.forEach(d => {
    const k = d.data();
    const key = k.ogrenci_no + "|" + k.davranis;
    if (!sayimlar[key]) sayimlar[key] = { ...k, sayi: 0 };
    sayimlar[key].sayi++;
  });

  // Eşik aşılanları bul ve bildir
  let bildirilenSayisi = 0;
  for (const [key, veri] of Object.entries(sayimlar)) {
    const esik = turler[veri.davranis];
    if (esik && veri.sayi >= esik) {
      const mesaj = `⚠️ *DİSİPLİN BİLDİRİMİ*\n\n` +
        `Ogrenci: ${veri.ogrenci_ad}\n` +
        `Sinif: ${veri.sinif}\n` +
        `Davranis: ${veri.davranis}\n` +
        `Tekrar Sayisi: ${veri.sayi} (Esik: ${esik})\n` +
        `Donem: ${donem}. Donem`;
      await telegramMesajGonder(mesaj);
      bildirilenSayisi++;
    }
  }

  return {
    success: true,
    message: `${bildirilenSayisi} bildirim gonderildi.`
  };
});