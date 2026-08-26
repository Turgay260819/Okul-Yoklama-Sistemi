const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
setGlobalOptions({ region: "europe-west1" });

admin.initializeApp();
// firebase-admin@14 kök paketten eski namespace (compat) API'sini kaldırdı;
// admin.firestore()/admin.auth()/admin.firestore.FieldValue çağıran mevcut
// kod tabanını değiştirmemek için modüler API'yi aynı isimlere bağlıyoruz.
admin.firestore = getFirestore;
admin.firestore.FieldValue = FieldValue;
admin.auth = getAuth;

// schedule.day / dyk_courses.gun gibi alanlar Excel'den geldiği için Türkçe
// aksanlı ("salı") ya da aksansız ("sali") yazılmış olabilir — karşılaştırma
// yapan her yerde bu normalize fonksiyonu üzerinden kıyaslanmalı.
function normalizeGun(gun) {
  return String(gun || "")
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o");
}

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

  let uid;
  try {
    const userRecord = await admin.auth().createUser({
      email,
      password: sifre,
      displayName: ad
    });
    uid = userRecord.uid;
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      // Orphaned Auth account — reuse existing UID
      const existing = await admin.auth().getUserByEmail(email);
      uid = existing.uid;
      await admin.auth().updateUser(uid, { displayName: ad, password: sifre });
    } else {
      throw new HttpsError("internal", err.message);
    }
  }

  try {
    await admin.firestore().collection("teachers").add({
      uid, ad, brans, email,
      kimlik_sifre: sifre,
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
// ÖĞRETMEN SİL
// ===========================
exports.ogretmenSil = onCall(async (request) => {
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

  const { ogretmenId } = request.data;
  if (!ogretmenId) throw new HttpsError("invalid-argument", "ogretmenId zorunlu.");

  const teacherSnap = await admin.firestore().collection("teachers").doc(ogretmenId).get();
  if (!teacherSnap.exists) throw new HttpsError("not-found", "Öğretmen bulunamadı.");

  const uid = teacherSnap.data().uid;

  try {
    await admin.firestore().collection("teachers").doc(ogretmenId).delete();
    if (uid) {
      await admin.firestore().collection("users").doc(uid).delete();
      await admin.auth().deleteUser(uid);
    }
    return { success: true };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// ÖĞRETMEN GÜNCELLE
// ===========================
exports.ogretmenGuncelle = onCall(async (request) => {
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

  const { ogretmenId, ad, email, sifre } = request.data;
  if (!ogretmenId) throw new HttpsError("invalid-argument", "ogretmenId zorunlu.");

  const teacherRef = admin.firestore().collection("teachers").doc(ogretmenId);
  const teacherSnap = await teacherRef.get();
  if (!teacherSnap.exists) throw new HttpsError("not-found", "Öğretmen bulunamadı.");
  let uid = teacherSnap.data().uid;
  const yeniHesap = !uid;

  try {
    if (uid) {
      const authUpdate = {};
      if (ad)    authUpdate.displayName = ad;
      if (email) authUpdate.email = email;
      if (sifre) authUpdate.password = sifre;
      if (Object.keys(authUpdate).length) {
        await admin.auth().updateUser(uid, authUpdate);
      }
    } else {
      // Öğretmenin henüz Auth hesabı yok (örn. hiç kimlik atanmamış) — yeni oluştur.
      if (!email || !sifre) throw new HttpsError("invalid-argument", "Kimlik oluşturmak için email ve sifre gerekli.");
      const displayName = ad || teacherSnap.data().ad;
      try {
        const rec = await admin.auth().createUser({ email, password: sifre, displayName });
        uid = rec.uid;
      } catch (err) {
        if (err.code === "auth/email-already-exists") {
          const existing = await admin.auth().getUserByEmail(email);
          uid = existing.uid;
          await admin.auth().updateUser(uid, { password: sifre, displayName });
        } else {
          throw err;
        }
      }
    }

    const firestoreUpdate = {};
    if (ad)    firestoreUpdate.ad    = ad;
    if (email) firestoreUpdate.email = email;
    if (sifre) firestoreUpdate.kimlik_sifre = sifre;
    if (yeniHesap) firestoreUpdate.uid = uid;
    if (Object.keys(firestoreUpdate).length) {
      await teacherRef.update(firestoreUpdate);
    }

    const usersUpdate = {};
    if (ad)    usersUpdate.ad    = ad;
    if (email) usersUpdate.email = email;
    if (yeniHesap) usersUpdate.rol = "ogretmen";
    if (Object.keys(usersUpdate).length) {
      await admin.firestore().collection("users").doc(uid).set(usersUpdate, { merge: true });
    }

    return { success: true, uid };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// ÖĞRENCİ OLUŞTUR
// ===========================
exports.ogrenciOlustur = onCall(async (request) => {
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

  const { ad, ogrenci_no } = request.data;

  // İlk adı al, Türkçe karakterleri normalize et, küçük harfe çevir
  const ilkAd = (ad || "").split(" ")[0]
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ı/g, "i")
    .replace(/İ/gi, "i").replace(/[^a-z0-9]/g, "");
  const email = `${ilkAd}${ogrenci_no}@gmail.com`;
  const sifre = String(ogrenci_no);

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password: sifre,
      displayName: ad
    });

    const uid = userRecord.uid;

    await admin.firestore().collection("users").doc(uid).set({
      ad,
      email,
      rol: "ogrenci",
      ogrenci_no,
      ilk_giris: true,
      bildirim_aktif: false,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, uid };

  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// ÖĞRENCİ HESAP OLUŞTUR / GÜNCELLE
// ===========================
exports.ogrenciHesapOlustur = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const { ogrenciId, email, sifre } = request.data;
  if (!ogrenciId || !email || !sifre) throw new HttpsError("invalid-argument", "Eksik veri.");

  const ogrRef = admin.firestore().collection("students").doc(ogrenciId);
  const ogrSnap = await ogrRef.get();
  if (!ogrSnap.exists) throw new HttpsError("not-found", "Öğrenci bulunamadı.");
  const ogrData = ogrSnap.data();

  let uid = ogrData.kimlik_uid || null;

  try {
    if (uid) {
      await admin.auth().updateUser(uid, { email, password: sifre, displayName: ogrData.name });
    } else {
      try {
        const rec = await admin.auth().createUser({ email, password: sifre, displayName: ogrData.name });
        uid = rec.uid;
      } catch (err) {
        if (err.code === "auth/email-already-exists") {
          const existing = await admin.auth().getUserByEmail(email);
          uid = existing.uid;
          await admin.auth().updateUser(uid, { password: sifre, displayName: ogrData.name });
        } else {
          throw err;
        }
      }
    }

    await admin.firestore().collection("users").doc(uid).set({
      ad: ogrData.name,
      email,
      rol: "ogrenci",
      ogrenci_no: ogrData.student_number || "",
      ilk_giris: false,
      bildirim_aktif: false,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await ogrRef.update({ kimlik_email: email, kimlik_sifre: sifre, kimlik_uid: uid });

    return { success: true, uid };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// ÖĞRENCİ SİL (Auth + Users + Students)
// ===========================
exports.ogrenciSilTamamen = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const { ogrenciId } = request.data;
  if (!ogrenciId) throw new HttpsError("invalid-argument", "ogrenciId gerekli.");

  const ogrRef = admin.firestore().collection("students").doc(ogrenciId);
  const ogrSnap = await ogrRef.get();

  if (ogrSnap.exists) {
    const uid = ogrSnap.data().kimlik_uid;
    if (uid) {
      try { await admin.auth().deleteUser(uid); } catch (e) {}
      await admin.firestore().collection("users").doc(uid).delete();
    }
    await ogrRef.delete();
  }

  return { success: true };
});

// ===========================
// GÜN SONU DEVAMSIZLIK HESABI
// Bir sınıfın o günkü tüm ders yoklamaları girilmişse
// daily_summary'ye tam gün/yarım gün kaydı yazar.
// gunSonuKontrol (16:00) ve attendanceYazildiginda (her yoklama
// kaydında) tarafından ortak kullanılır — böylece 16:00'dan sonra
// geç girilen yoklamalar da güne dahil olur.
// ===========================
async function hesaplaVeYazDailySummary(db, tarih, sinif) {
  const [todaySnap, yoklamaSnap, mevcutOzetSnap] = await Promise.all([
    db.collection("today_lessons").where("date", "==", tarih).where("class_id", "==", sinif).get(),
    db.collection("attendance").where("date", "==", tarih).where("class_id", "==", sinif).get(),
    db.collection("daily_summary").where("date", "==", tarih).where("class_id", "==", sinif).get(),
  ]);

  const toplamDers = todaySnap.size;
  if (toplamDers === 0) return { tamamlandi: false };

  // Aynı ders için birden fazla kayıt olabileceğinden (düzeltme/tekrar giriş),
  // tamamlanma kontrolünü benzersiz ders numarası sayısına göre yap.
  const girilenDersNolari = new Set();
  yoklamaSnap.forEach(doc => girilenDersNolari.add(doc.data().lesson_number));
  if (girilenDersNolari.size < toplamDers) return { tamamlandi: false };

  const ogrenciYokSayisi = {};
  yoklamaSnap.forEach(doc => {
    (doc.data().absent_students || []).forEach(ogrNo => {
      ogrenciYokSayisi[ogrNo] = (ogrenciYokSayisi[ogrNo] || 0) + 1;
    });
  });

  const batch = db.batch();
  for (const [ogrNo, yokSayisi] of Object.entries(ogrenciYokSayisi)) {
    const durum = yokSayisi >= toplamDers ? "full_day_absent" : "half_day_absent";
    const ref = db.collection("daily_summary").doc(`${tarih}_${sinif}_${ogrNo}`);
    batch.set(ref, {
      date: tarih,
      class_id: sinif,
      student_number: ogrNo,
      status: durum,
      absent_lesson_count: yokSayisi,
      total_lessons: toplamDers,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  // Bir düzeltme sonucu artık devamsız sayılmayan öğrencinin eski özet
  // kaydı kalıcılaşmasın diye, güncel listede olmayanları temizle.
  mevcutOzetSnap.forEach(doc => {
    if (!(doc.data().student_number in ogrenciYokSayisi)) batch.delete(doc.ref);
  });
  await batch.commit();
  return { tamamlandi: true };
}

// ===========================
// GÜN SONU KONTROL
// Her gün 16:00'da (Türkiye saati) çalışır
// ===========================
exports.gunSonuKontrol = onSchedule({ schedule: "0 16 * * 1-5", timeZone: "Europe/Istanbul" }, async (event) => {
  const db = admin.firestore();

  const bugun = new Date().toISOString().split("T")[0];

  // Eksik yoklamaları bul
  const eksikSnap = await db.collection("today_lessons")
    .where("date", "==", bugun)
    .where("status", "==", "pending")
    .get();

  // O gün dersi olan sınıfları bul
  const todaySnap = await db.collection("today_lessons")
    .where("date", "==", bugun)
    .get();
  const siniflar = new Set();
  todaySnap.forEach(doc => siniflar.add(doc.data().class_id));

  for (const sinif of siniflar) {
    await hesaplaVeYazDailySummary(db, bugun, sinif);
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
// YOKLAMA KAYDI YAZILDIĞINDA
// Bir dersin yoklaması (geç de olsa) girildiğinde, sınıfın o günkü
// tüm dersleri tamamlandıysa daily_summary'yi hemen günceller.
// ===========================
exports.attendanceYazildiginda = onDocumentCreated("attendance/{attendanceId}", async (event) => {
  const veri = event.data?.data();
  if (!veri?.date || !veri?.class_id) return;
  await hesaplaVeYazDailySummary(admin.firestore(), veri.date, veri.class_id);
});

// ===========================
// BUGÜNÜN DERSLERİNİ OLUŞTUR
// Her sabah 06:00'da çalışır
// ===========================
exports.bugunDersleriniOlustur = onSchedule({ schedule: "0 3 * * *", timeZone: "Europe/Istanbul" }, async (event) => {
  const db = admin.firestore();
  const bugun = new Date();
  const gunler = ["pazar", "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi"];
  const bugunAdi = normalizeGun(gunler[bugun.getDay()]);
  const tarih = bugun.toISOString().split("T")[0];

  if (bugunAdi === "cumartesi" || bugunAdi === "pazar") {
    console.log("Hafta sonu, ders oluşturulmadı.");
    return;
  }

  const mevcutSnap = await db.collection("today_lessons")
    .where("date", "==", tarih)
    .get();
  if (!mevcutSnap.empty) {
    console.log("Bugünün dersleri zaten oluşturulmuş.");
    return;
  }

  // schedule.day yazımı (Türkçe aksanlı/aksansız) Excel kaynağına göre değişebildiğinden
  // tüm program çekilip normalizeGun ile karşılaştırılıyor (exact-match .where() yerine).
  const tumProgramSnap = await db.collection("schedule").get();
  const programDocs = tumProgramSnap.docs.filter(d => normalizeGun(d.data().day) === bugunAdi);
  if (programDocs.length === 0) {
    console.log("Bugün için ders programı yok.");
    return;
  }

  const batch = db.batch();
  programDocs.forEach(doc => {
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
  console.log(`${tarih} için ${programDocs.length} ders oluşturuldu.`);
});

// ===========================
// MANUEL TODAY_LESSONS OLUŞTUR
// Admin panelinden tetiklenebilir
// ===========================
// ===========================
// TELEGRAM BİLDİRİM GÖNDERİCİ
// ===========================
async function telegramMesajGonderKisiye(chatId, mesaj) {
  const https = require("https");
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId, text: mesaj, parse_mode: "HTML" });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
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

async function telegramMesajGonder(mesaj) {
  return telegramMesajGonderKisiye(TELEGRAM_CHAT_ID, mesaj);
}

// Hedef kitleden öğretmen listesi döndür (Cloud Function tarafı)
async function hedefOgretmenleriniGetir(db, hedef_kitle) {
  const snap = await db.collection("teachers").get();
  const teachers = [];
  snap.forEach(d => teachers.push({ id: d.id, ...d.data() }));

  if (!hedef_kitle || hedef_kitle.tip === "hepsi") return teachers;
  if (hedef_kitle.tip === "zumre")
    return teachers.filter(t => t.brans === hedef_kitle.deger);
  if (hedef_kitle.tip === "sinif_rehberi")
    return teachers.filter(t => t.sinifSeviye === hedef_kitle.deger);
  if (hedef_kitle.tip === "sube_rehberi")
    return teachers.filter(t => t.rehberSube === hedef_kitle.deger);
  if (hedef_kitle.tip === "manuel") {
    const ids = new Set(hedef_kitle.ogretmenler || []);
    return teachers.filter(t => ids.has(t.id));
  }
  return teachers;
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

  if (request.data?.tip === "nobet2") {
    const [nbDoc, nokDoc] = await Promise.all([
      db.collection("nobet2_ayarlar").doc("mevcut").get(),
      db.collection("nobet2_ayarlar").doc("noktalar").get(),
    ]);
    if (!nbDoc.exists) throw new HttpsError("not-found", "Gun degisme nobeti verisi bulunamadi.");

    const nb = nbDoc.data();
    const NOKTALAR = nokDoc.exists ? (nokDoc.data().liste || []) : [];
    const slotlar = nb.slotlar || [];
    const N = NOKTALAR.length;
    if (!N) throw new HttpsError("not-found", "Nobet noktalari tanimlanmamis.");

    const GUNLER = ["Pazartesi", "Sali", "Carsamba", "Persembe", "Cuma"];
    const slotToPos = (slot) => ({ gi: Math.floor(slot / N), ni: slot % N });

    // nobet2.html / nobet.html'deki uc dalli rotasyon mantiginin sunucu
    // tarafindaki birebir kopyasi (sabit_gun dahil) — tutarli olmasi icin
    // ucu de senkron tutulmali.
    function serbestSlotListesi(slots) {
      const sgn = new Set();
      const sabitGunler = new Set();
      slots.forEach((s) => {
        if (s.sabitlik === "sgn") sgn.add(s.baslangic_slot);
        else if (s.sabitlik === "sabit_gun") sabitGunler.add(slotToPos(s.baslangic_slot).gi);
      });
      const liste = [];
      for (let adim = 0; adim < 5 * N; adim++) {
        const gi = adim % 5;
        const ni = adim % N;
        if (sabitGunler.has(gi)) continue;
        const slot = gi * N + ni;
        if (!sgn.has(slot) && !liste.includes(slot)) liste.push(slot);
      }
      return liste;
    }

    function sabitGunNoktaHavuzu(gi, slots) {
      const sgnNoktalari = new Set();
      slots.forEach((t) => {
        if (t.sabitlik === "sgn" && slotToPos(t.baslangic_slot).gi === gi)
          sgnNoktalari.add(slotToPos(t.baslangic_slot).ni);
      });
      const havuz = [];
      for (let ni = 0; ni < N; ni++) if (!sgnNoktalari.has(ni)) havuz.push(ni);
      return havuz;
    }

    function pozHesapla(s, sayac, slots) {
      if (s.sabitlik === "sgn") return slotToPos(s.baslangic_slot);
      if (s.sabitlik === "sabit_gun") {
        const gi = slotToPos(s.baslangic_slot).gi;
        const havuz = sabitGunNoktaHavuzu(gi, slots);
        if (!havuz.length) return slotToPos(s.baslangic_slot);
        const basNi = slotToPos(s.baslangic_slot).ni;
        const basIdx = havuz.indexOf(basNi);
        const idx = basIdx < 0 ? 0 : basIdx;
        const yeniIdx = (((idx + sayac) % havuz.length) + havuz.length) % havuz.length;
        return { gi, ni: havuz[yeniIdx] };
      }
      const serbest = serbestSlotListesi(slots);
      if (!serbest.length) return slotToPos(s.baslangic_slot);
      const basIdx = serbest.indexOf(s.baslangic_slot);
      const idx = basIdx < 0 ? 0 : basIdx;
      const yeniIdx = (((idx + sayac) % serbest.length) + serbest.length) % serbest.length;
      return slotToPos(serbest[yeniIdx]);
    }

    const sayac = nb.rotasyon_sayaci || 0;
    const baslangic2 = new Date(nb.hafta_baslangic + "T12:00:00");
    const formatTarih2 = (d) => {
      const gun = String(d.getDate()).padStart(2, "0");
      const ay = String(d.getMonth() + 1).padStart(2, "0");
      return `${gun}.${ay}.${d.getFullYear()}`;
    };

    const gunNobetciler = GUNLER.map(() => []);
    slotlar.forEach((s) => {
      const pos = pozHesapla(s, sayac, slotlar);
      gunNobetciler[pos.gi].push({ ni: pos.ni, ad: s.ogretmen_ad });
    });

    let mesaj2 = `📋 *GÜN DEĞİŞME NÖBET ÇİZELGESİ*\n`;
    mesaj2 += `------------------------------------------\n\n`;
    GUNLER.forEach((gun, gi) => {
      const gunTarihi = new Date(baslangic2);
      gunTarihi.setDate(baslangic2.getDate() + gi);
      mesaj2 += `🗓 *${formatTarih2(gunTarihi)} ${gun}*\n`;
      mesaj2 += "`\n";
      const oGununNobetcileri = gunNobetciler[gi].sort((a, b) => a.ni - b.ni);
      if (oGununNobetcileri.length) {
        oGununNobetcileri.forEach((n) => {
          const noktaPad = (NOKTALAR[n.ni] || "-").padEnd(12, " ");
          mesaj2 += `${noktaPad}: ${n.ad}\n`;
        });
      } else {
        mesaj2 += "Nobetci yok\n";
      }
      mesaj2 += "`\n\n";
    });

    await telegramMesajGonder(mesaj2);
    return { success: true };
  }

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
    { ad: "Okul kulturune uyumsuzluk", esik: 2, sira: 7, aktif: true },
    { ad: "Cep Telefonu Bulundurma", esik: 1, sira: 8, aktif: true }
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

// ===========================
// DİSİPLİN KAYDI YAZILDIĞINDA — EŞİK KONTROLÜ
// Bir öğrencinin aynı dönemde aynı davranıştan aldığı kayıt sayısı,
// o davranışın eşiğine tam ulaştığı anda Telegram'a bildirim gönderir.
// (disiplinEsikKontrol hiçbir yerden çağrılmıyordu, bu yüzden eşik
// bildirimi hiç otomatik çalışmıyordu — bu tetikleyici onun yerini alır.)
// ===========================
exports.disiplinKaydiYazildiginda = onDocumentCreated("disiplin_kayitlar/{kayitId}", async (event) => {
  const veri = event.data?.data();
  if (!veri?.ogrenci_no || !veri?.davranis || !veri?.donem) return;

  const db = admin.firestore();
  const turSnap = await db.collection("disiplin_turleri")
    .where("ad", "==", veri.davranis).where("aktif", "==", true).limit(1).get();
  if (turSnap.empty) return;
  const esik = turSnap.docs[0].data().esik;
  if (!esik) return;

  const kayitSnap = await db.collection("disiplin_kayitlar")
    .where("ogrenci_no", "==", veri.ogrenci_no)
    .where("davranis", "==", veri.davranis)
    .where("donem", "==", veri.donem).get();
  if (kayitSnap.size !== esik) return;

  const mesaj = `⚠️ *DİSİPLİN BİLDİRİMİ*\n\n` +
    `Ogrenci: ${veri.ogrenci_ad}\n` +
    `Sinif: ${veri.sinif}\n` +
    `Davranis: ${veri.davranis}\n` +
    `Tekrar Sayisi: ${kayitSnap.size} (Esik: ${esik})\n` +
    `Donem: ${veri.donem}. Donem`;
  await telegramMesajGonder(mesaj);
});

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
  const gunler = ["pazar", "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi"];
  const bugunAdi = normalizeGun(gunler[bugunObj.getDay()]);

  // Mevcut kayıtları sil
  const mevcutSnap = await db.collection("today_lessons")
    .where("date", "==", tarih)
    .get();

  const deleteBatch = db.batch();
  mevcutSnap.forEach(doc => deleteBatch.delete(doc.ref));
  await deleteBatch.commit();

  // schedule.day yazımı Excel kaynağına göre değişebildiğinden tüm program
  // çekilip normalizeGun ile karşılaştırılıyor (exact-match .where() yerine).
  const tumProgramSnap = await db.collection("schedule").get();
  const programDocs = tumProgramSnap.docs.filter(d => normalizeGun(d.data().day) === bugunAdi);

  if (programDocs.length === 0) {
    return { success: false, message: "Bu gün için ders programı yok." };
  }

  const batch = db.batch();
  programDocs.forEach(doc => {
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
  return { success: true, message: `${programDocs.length} ders oluşturuldu.` };
});

// ===========================
// GÖREV ATANDI — TELEGRAM BİLDİRİMİ
// Admin portal'dan tetiklenir
// ===========================
exports.gorevAtandiBildir = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const { baslik, aciklama, atananlar, sonTarih, olusturanAd } = request.data;

  const tarihStr = sonTarih
    ? sonTarih.split("-").reverse().join(".")
    : "-";

  let mesaj = `📋 <b>YENİ GÖREVLENDİRME</b>\n\n`;
  mesaj += `<b>Görev:</b> ${baslik}\n`;
  if (aciklama) mesaj += `<b>Açıklama:</b> ${aciklama}\n`;
  mesaj += `<b>Atanan:</b> ${(atananlar || []).join(", ")}\n`;
  mesaj += `<b>Son Tarih:</b> ${tarihStr}\n`;
  mesaj += `<b>Oluşturan:</b> ${olusturanAd || "—"}`;

  try {
    await telegramMesajGonder(mesaj);
    return { success: true };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// GÖREV SON GÜN KONTROLÜ
// Her sabah 07:00'da çalışır (Istanbul)
// ===========================
exports.gorevSonGunKontrol = onSchedule(
  { schedule: "0 4 * * *", timeZone: "Europe/Istanbul" },
  async (event) => {
    const db = admin.firestore();
    const bugun = new Date().toISOString().split("T")[0];

    const snap = await db.collection("gorevler")
      .where("durum", "==", "acik")
      .where("son_tarih", "==", bugun)
      .get();

    if (snap.empty) {
      console.log("Bugün son günü olan açık görev yok.");
      return;
    }

    for (const gorevDoc of snap.docs) {
      const g = gorevDoc.data();
      const tarihStr = bugun.split("-").reverse().join(".");
      let mesaj = `⏰ <b>GÖREV SON GÜNÜ</b>\n\n`;
      mesaj += `<b>Görev:</b> ${g.baslik}\n`;
      if (g.aciklama) mesaj += `<b>Açıklama:</b> ${g.aciklama}\n`;
      mesaj += `<b>Atanan:</b> ${(g.atananlar || []).join(", ")}\n`;
      mesaj += `<b>Son Tarih:</b> ${tarihStr} <b>(BUGÜN)</b>\n`;
      mesaj += `<b>Oluşturan:</b> ${g.olusturan_ad || "—"}`;
      await telegramMesajGonder(mesaj);
    }

    console.log(`${snap.size} görev son gün bildirimi gönderildi.`);
  }
);

// ===========================
// ANKET/FORM YAYINLANDI — ÖĞRETMENLERE BİLDİRİM
// Admin anket yayınladığında tetiklenir
// ===========================
exports.anketBildir = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const db = admin.firestore();
  const { anketId, baslik, aciklama, sonTarih, hedefIds } = request.data;

  if (!hedefIds || !hedefIds.length) return { success: true, yazilan: 0 };

  const hedefSet = new Set(hedefIds);
  const tarihGoster = sonTarih ? sonTarih.replace("T", " ") : null;
  let mesajMetni = aciklama || "";
  if (tarihGoster) mesajMetni += (mesajMetni ? " — " : "") + `Son: ${tarihGoster}`;

  // Her hedef öğretmene sistem bildirimi (Firestore)
  const batch = db.batch();
  let yazilan = 0;
  for (const ogretmenId of hedefSet) {
    const ref = db.collection("bildirimler").doc();
    batch.set(ref, {
      alici_id: ogretmenId,
      tip: "anket",
      baslik: `Yeni form: ${baslik}`,
      mesaj: mesajMetni,
      referans_id: anketId || "",
      okundu: false,
      tarih: admin.firestore.FieldValue.serverTimestamp(),
    });
    yazilan++;
  }
  await batch.commit();

  // Admine tek Telegram özeti
  let adminMesaj = `📋 <b>FORM YAYINLANDI</b>\n\n`;
  adminMesaj += `<b>Form:</b> ${baslik}\n`;
  if (aciklama) adminMesaj += `<b>Açıklama:</b> ${aciklama}\n`;
  if (tarihGoster) adminMesaj += `<b>Son Tarih:</b> ${tarihGoster}\n`;
  adminMesaj += `<b>Bildirim Gönderilen:</b> ${yazilan} öğretmen`;
  try {
    await telegramMesajGonder(adminMesaj);
  } catch (err) {
    console.error("Admin Telegram hatası:", err.message);
  }

  return { success: true, yazilan };
});

// ===========================
// ANKET/FORM BİTİŞ KONTROLÜ
// Her 30 dakikada çalışır — kapanan formlarda yanıt vermeyenleri admine bildirir
// ===========================
exports.anketBitisKontrol = onSchedule(
  { schedule: "*/30 * * * *", timeZone: "Europe/Istanbul" },
  async (event) => {
    const db = admin.firestore();

    // İstanbul saatini YYYY-MM-DDTHH:mm formatında al
    const simdi = new Date();
    const istanbulStr = simdi
      .toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" })
      .replace(" ", "T")
      .slice(0, 16);

    const snap = await db.collection("anketler")
      .where("durum", "==", "aktif")
      .get();

    if (snap.empty) return;

    for (const anketDoc of snap.docs) {
      const anket = anketDoc.data();
      if (!anket.son_tarih) continue;
      if (anket.son_tarih > istanbulStr) continue;

      // Form kapandı — yanıt vermeyenleri bul
      const hedefOgretmenler = await hedefOgretmenleriniGetir(db, anket.hedef_kitle);

      const yanSnap = await db.collection("anket_yanitlar")
        .where("anket_id", "==", anketDoc.id)
        .get();

      const yanitliIds = new Set();
      yanSnap.forEach(d => yanitliIds.add(d.data().ogretmen_id));

      const yanıtlamayanlar = hedefOgretmenler
        .filter(t => !yanitliIds.has(t.id))
        .map(t => t.ad || t.id);

      const tarihGoster = anket.son_tarih.replace("T", " ");

      let mesaj = `📋 <b>FORM KAPANDI</b>\n\n`;
      mesaj += `<b>Form:</b> ${anket.baslik}\n`;
      mesaj += `<b>Son Tarih:</b> ${tarihGoster}\n`;
      mesaj += `<b>Yanıtlayan:</b> ${yanSnap.size} kişi\n`;
      mesaj += `<b>Yanıtlamayan:</b> ${yanıtlamayanlar.length} kişi`;
      if (yanıtlamayanlar.length > 0) {
        mesaj += `\n\n<b>Yanıt Vermeyenler:</b>\n${yanıtlamayanlar.join(", ")}`;
      }

      try {
        await telegramMesajGonder(mesaj);
      } catch (err) {
        console.error("Telegram kapanış bildirimi hatası:", err.message);
      }

      // Formu kapat
      await anketDoc.ref.update({ durum: "kapali" });
      console.log(`Form kapandı ve bildirim gönderildi: ${anket.baslik}`);
    }
  }
);