const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentCreatedWithAuthContext, onDocumentDeletedWithAuthContext } = require("firebase-functions/v2/firestore");
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

// Admin'in tanımladığı yaz tatili/ara tatil/bayram tatili gibi tarih
// aralıklarında ders/yoklama oluşturulmaması için kontrol edilir.
async function tatilKontrol(db, tarih) {
  const snap = await db.collection("tatil_donemleri").get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.baslangic && d.bitis && tarih >= d.baslangic && tarih <= d.bitis) return d.ad;
  }
  return null;
}

// settings/genel.okul_baslangic_tarihi / okul_bitis_tarihi disindaki gunlerde
// ne ders/yoklama olusturma ne de nobet islemleri calismamali. Alanlardan biri
// bos ise (admin henuz girmemisse) o yondeki sinir uygulanmaz.
async function okulDonemDisindaMi(db, tarih) {
  const ayarDoc = await db.collection("settings").doc("genel").get();
  const ayar = ayarDoc.exists ? ayarDoc.data() : {};
  if (ayar.okul_baslangic_tarihi && tarih < ayar.okul_baslangic_tarihi) return "baslamadi";
  if (ayar.okul_bitis_tarihi && tarih > ayar.okul_bitis_tarihi) return "bitti";
  return null;
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

    const usersUpdate = { rol: "ogretmen" };
    if (ad)    usersUpdate.ad    = ad;
    if (email) usersUpdate.email = email;
    await admin.firestore().collection("users").doc(uid).set(usersUpdate, { merge: true });

    return { success: true, uid };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// ÖĞRETMEN ROLLERİNİ ONAR
// ===========================
// "users/{uid}" belgesinde rol alani eksik kalmis (ör. eski/bozuk veri, ya da
// ogretmenGuncelle'nin bir onceki suru sadece yeni hesaplarda rol set ediyordu)
// ogretmenleri tarayip duzeltir. Boyle bir hesap icin isOgretmen()/isYonetim()
// firestore.rules kontrolleri hep false donuyor, bu da "Missing or insufficient
// permissions" hatasina yol aciyordu.
exports.ogretmenRolleriniOnar = onCall(async (request) => {
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

  const teachersSnap = await admin.firestore().collection("teachers").get();
  let duzeltilen = 0;

  for (const teacherDoc of teachersSnap.docs) {
    const uid = teacherDoc.data().uid;
    if (!uid) continue;
    const userRef = admin.firestore().collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists || userSnap.data().rol !== "ogretmen") {
      await userRef.set({ rol: "ogretmen" }, { merge: true });
      duzeltilen++;
    }
  }

  return { success: true, duzeltilen };
});

// ===========================
// SALT-OKUNUR İDARECİ HESABI (idareci_izleyici)
// Admin ekranlarinin tamamini gorur ama hicbir sey yazamaz (bkz. firestore.rules
// isIzleyici/isYazabilir). Kisinin ogretmen hesabindan tamamen ayri, ikinci bir
// hesaptir; teachers koleksiyonuna kayit acilmaz. users koleksiyonu tum giris
// yapmis kullanicilara acik oldugu icin sifre orada saklanmaz.
// ===========================
async function adminMiKontrol(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");
  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  if (callerDoc.data()?.rol !== "admin") {
    throw new HttpsError("permission-denied", "Bu işlemi sadece admin yapabilir.");
  }
}

exports.izleyiciHesapOlustur = onCall(async (request) => {
  await adminMiKontrol(request);

  const ad = String(request.data?.ad || "").trim();
  const gorev = String(request.data?.gorev || "").trim();
  const email = String(request.data?.email || "").trim().toLowerCase();
  const sifre = String(request.data?.sifre || "");
  if (!ad) throw new HttpsError("invalid-argument", "Ad soyad zorunlu.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "Geçerli bir e-posta girin.");
  if (sifre.length < 6) throw new HttpsError("invalid-argument", "Şifre en az 6 karakter olmalı.");

  // ogretmenOlustur'un aksine mevcut hesabi YENIDEN KULLANMIYORUZ: yanlislikla
  // kisinin ogretmen e-postasi girilirse o hesap salt-okunura donusmesin.
  let uid;
  try {
    uid = (await admin.auth().createUser({ email, password: sifre, displayName: ad })).uid;
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Bu e-posta ile zaten bir hesap var. Öğretmen hesabından farklı bir e-posta kullanın.");
    }
    throw new HttpsError("internal", err.message);
  }

  try {
    await admin.firestore().collection("users").doc(uid).set({
      ad, email, gorev,
      rol: "idareci_izleyici",
      bildirim_aktif: false,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    await admin.auth().deleteUser(uid).catch(() => {});
    throw new HttpsError("internal", err.message);
  }
  return { success: true, uid };
});

exports.izleyiciHesapSil = onCall(async (request) => {
  await adminMiKontrol(request);
  const uid = String(request.data?.uid || "");
  if (!uid) throw new HttpsError("invalid-argument", "uid zorunlu.");

  const userRef = admin.firestore().collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists || userSnap.data().rol !== "idareci_izleyici") {
    throw new HttpsError("failed-precondition", "Bu hesap bir görüntüleme hesabı değil.");
  }
  await admin.auth().deleteUser(uid).catch((err) => {
    if (err.code !== "auth/user-not-found") throw new HttpsError("internal", err.message);
  });
  await userRef.delete();
  return { success: true };
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

  const donemDurumu = await okulDonemDisindaMi(db, tarih);
  if (donemDurumu) {
    console.log(`${tarih} okul donemi disinda (${donemDurumu}), ders oluşturulmadı.`);
    return;
  }

  const tatilAdi = await tatilKontrol(db, tarih);
  if (tatilAdi) {
    console.log(`${tarih} tatil dönemine (${tatilAdi}) denk geliyor, ders oluşturulmadı.`);
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

// parse_mode "HTML" kullanildigi icin mesaja giren kullanici verisindeki
// <, >, & karakterleri kacislanmali; yoksa Telegram mesaji reddeder.
function htmlKacis(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
// nobet2.html'deki uc dalli rotasyon mantiginin (sabit_gun dahil) sunucu
// tarafindaki paylasilan kopyasi — hem nobetTelegramGonder hem
// nobetBugunKontrol bunu kullanir, ayri kopyalar acilmaz.
function nobet2SlotToPos(slot, N) {
  return { gi: Math.floor(slot / N), ni: slot % N };
}

function nobet2SabitGunNoktaHavuzu(gi, slots, N) {
  const sgnNoktalari = new Set();
  slots.forEach((t) => {
    if (t.sabitlik === "sgn" && nobet2SlotToPos(t.baslangic_slot, N).gi === gi)
      sgnNoktalari.add(nobet2SlotToPos(t.baslangic_slot, N).ni);
  });
  const havuz = [];
  for (let ni = 0; ni < N; ni++) if (!sgnNoktalari.has(ni)) havuz.push(ni);
  return havuz;
}

// "sabit_gun" ogretmenlerinin bu haftaki (sayac'a gore) gercek pozisyonu.
function nobet2SabitGunPozisyonu(s, sayac, slots, N) {
  const gi = nobet2SlotToPos(s.baslangic_slot, N).gi;
  const havuz = nobet2SabitGunNoktaHavuzu(gi, slots, N);
  if (!havuz.length) return nobet2SlotToPos(s.baslangic_slot, N);
  const basNi = nobet2SlotToPos(s.baslangic_slot, N).ni;
  const basIdx = havuz.indexOf(basNi);
  const idx = basIdx < 0 ? 0 : basIdx;
  const yeniIdx = (((idx + sayac) % havuz.length) + havuz.length) % havuz.length;
  return { gi, ni: havuz[yeniIdx] };
}

// Serbest rotasyon havuzu: sgn slotlari her zaman, sabit_gun slotlari ise
// sadece o haftaki gercekte dolu (gun,nokta) pozisyonu kadar cikarilir —
// bir gunun tamami degil, sadece o an dolu olan nokta havuzdan dusurulur.
function nobet2SerbestSlotListesi(slots, sayac, N) {
  const sgn = new Set();
  const doluSabitGun = new Set();
  slots.forEach((s) => {
    if (s.sabitlik === "sgn") sgn.add(s.baslangic_slot);
    else if (s.sabitlik === "sabit_gun") {
      const pos = nobet2SabitGunPozisyonu(s, sayac, slots, N);
      doluSabitGun.add(pos.gi * N + pos.ni);
    }
  });
  const liste = [];
  for (let adim = 0; adim < 5 * N; adim++) {
    const gi = adim % 5;
    const ni = adim % N;
    const slot = gi * N + ni;
    if (!sgn.has(slot) && !doluSabitGun.has(slot) && !liste.includes(slot)) liste.push(slot);
  }
  return liste;
}

function nobet2PozHesapla(s, sayac, slots, N) {
  if (s.sabitlik === "sgn") return nobet2SlotToPos(s.baslangic_slot, N);
  if (s.sabitlik === "sabit_gun") return nobet2SabitGunPozisyonu(s, sayac, slots, N);
  const serbest = nobet2SerbestSlotListesi(slots, sayac, N);
  if (!serbest.length) return nobet2SlotToPos(s.baslangic_slot, N);
  let idx = serbest.indexOf(s.baslangic_slot);
  if (idx < 0) {
    // Orijinal slot bu hafta bir sabit_gun ogretmeni tarafindan dolu —
    // tum yetim ogretmenlerin 0'a cakismamasi icin, orijinal slot
    // numarasindan sonraki ilk bos slota (dongusel) yerlesir.
    idx = serbest.findIndex((slotNo) => slotNo >= s.baslangic_slot);
    if (idx < 0) idx = 0;
  }
  const yeniIdx = (((idx + sayac) % serbest.length) + serbest.length) % serbest.length;
  return nobet2SlotToPos(serbest[yeniIdx], N);
}

// Bugun (verilen tarih) nobetci olan ogretmenlerin id setini dondurur.
// raporluIcinVekilAta tarafindan "nobetci once" onceliklendirmesi icin kullanilir.
async function bugunNobetciIdSeti(db, bugun, bugunGi) {
  const [nbDoc, nokDoc] = await Promise.all([
    db.collection("nobet2_ayarlar").doc("mevcut").get(),
    db.collection("nobet2_ayarlar").doc("noktalar").get(),
  ]);
  if (!nbDoc.exists) return new Set();

  const nb = nbDoc.data();
  const NOKTALAR = nokDoc.exists ? (nokDoc.data().liste || []) : [];
  const N = NOKTALAR.length;
  if (!N) return new Set();

  const slotlar = nb.slotlar || [];
  const haftaBas = new Date(nb.hafta_baslangic + "T12:00:00");
  const haftaBit = new Date(haftaBas);
  haftaBit.setDate(haftaBas.getDate() + 4);
  const bugunTarih = new Date(bugun + "T12:00:00");
  if (bugunTarih < haftaBas || bugunTarih > haftaBit) return new Set();

  const sayac = nb.rotasyon_sayaci || 0;
  const idSeti = new Set();
  slotlar.forEach((s) => {
    const pos = nobet2PozHesapla(s, sayac, slotlar, N);
    if (pos.gi === bugunGi) idSeti.add(s.ogretmen_id);
  });
  return idSeti;
}

// today_lessons'a gore, o gun en az bir dersi olan ogretmenlerin ders
// saatleri arasindaki bosluklari saat bazinda gruplar: { [lesson_number]:
// [{id, ad}] }. haricTutulacakIds icindeki ogretmenler havuza hic girmez
// (ör. bugun raporlu olanlar). "Ara Bosluğu Olan Ogretmenler" bildirimi ve
// raporluIcinVekilAta tarafindan ortak kullanilir.
function saatBazliBosOgretmenler(lessonsSnap, ogretmenAdMap, haricTutulacakIds = new Set()) {
  const doluSaatler = {};
  const isaretle = (tid, saat) => {
    if (!tid) return;
    if (!doluSaatler[tid]) doluSaatler[tid] = new Set();
    doluSaatler[tid].add(saat);
  };
  lessonsSnap.forEach((d) => {
    const data = d.data();
    isaretle(data.teacher_id, data.lesson_number);
    if (data.substitute_teacher_id) isaretle(data.substitute_teacher_id, data.lesson_number);
  });

  const saatteBosOlanlar = {};
  Object.entries(doluSaatler).forEach(([tid, saatSet]) => {
    if (haricTutulacakIds.has(tid)) return;
    const saatler = [...saatSet].sort((a, b) => a - b);
    const ilk = saatler[0];
    const son = saatler[saatler.length - 1];
    for (let s = ilk + 1; s < son; s++) {
      if (!saatSet.has(s)) {
        if (!saatteBosOlanlar[s]) saatteBosOlanlar[s] = [];
        saatteBosOlanlar[s].push({ id: tid, ad: ogretmenAdMap[tid] || tid });
      }
    }
  });
  return saatteBosOlanlar;
}

exports.nobetTelegramGonder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const db = admin.firestore();

  const [nbDoc, nokDoc, ayarDoc, tatilSnap] = await Promise.all([
    db.collection("nobet2_ayarlar").doc("mevcut").get(),
    db.collection("nobet2_ayarlar").doc("noktalar").get(),
    db.collection("settings").doc("genel").get(),
    db.collection("tatil_donemleri").get(),
  ]);
  if (!nbDoc.exists) throw new HttpsError("not-found", "Gun degisme nobeti verisi bulunamadi.");

  const nb = nbDoc.data();
  const ayar = ayarDoc.exists ? ayarDoc.data() : {};
  const tatiller = tatilSnap.docs.map((d) => d.data());
  const NOKTALAR = nokDoc.exists ? (nokDoc.data().liste || []) : [];
  const slotlar = nb.slotlar || [];
  const N = NOKTALAR.length;
  if (!N) throw new HttpsError("not-found", "Nobet noktalari tanimlanmamis.");

  const haftaBasStr = nb.hafta_baslangic;
  const haftaBitStr = nobet2TarihEkle(haftaBasStr, 4);
  if (ayar.okul_baslangic_tarihi && haftaBitStr < ayar.okul_baslangic_tarihi)
    return { success: false, message: "Okul henuz baslamadi." };
  if (ayar.okul_bitis_tarihi && haftaBasStr > ayar.okul_bitis_tarihi)
    return { success: false, message: "Okul donemi sona erdi." };

  const GUNLER = ["Pazartesi", "Sali", "Carsamba", "Persembe", "Cuma"];
  const sayac = nb.rotasyon_sayaci || 0;
  const baslangic2 = new Date(nb.hafta_baslangic + "T12:00:00");
  const formatTarih2 = (d) => {
    const gun = String(d.getDate()).padStart(2, "0");
    const ay = String(d.getMonth() + 1).padStart(2, "0");
    return `${gun}.${ay}.${d.getFullYear()}`;
  };

  const gunNobetciler = GUNLER.map(() => []);
  slotlar.forEach((s) => {
    const pos = nobet2PozHesapla(s, sayac, slotlar, N);
    gunNobetciler[pos.gi].push({ ni: pos.ni, ad: s.ogretmen_ad });
  });

  let mesaj2 = `📋 *GÜN DEĞİŞME NÖBET ÇİZELGESİ*\n`;
  mesaj2 += `------------------------------------------\n\n`;
  GUNLER.forEach((gun, gi) => {
    const gunTarihi = new Date(baslangic2);
    gunTarihi.setDate(baslangic2.getDate() + gi);
    mesaj2 += `🗓 *${formatTarih2(gunTarihi)} ${gun}*\n`;
    mesaj2 += "`\n";
    const gunTarihiStr = gunTarihi.toISOString().split("T")[0];
    const gunTatili = tatiller.find(
      (t) => t.baslangic && t.bitis && gunTarihiStr >= t.baslangic && gunTarihiStr <= t.bitis
    );
    if (gunTatili) {
      mesaj2 += `Tatil: ${gunTatili.ad}\n`;
    } else {
      const oGununNobetcileri = gunNobetciler[gi].sort((a, b) => a.ni - b.ni);
      if (oGununNobetcileri.length) {
        oGununNobetcileri.forEach((n) => {
          const noktaPad = (NOKTALAR[n.ni] || "-").padEnd(12, " ");
          mesaj2 += `${noktaPad}: ${n.ad}\n`;
        });
      } else {
        mesaj2 += "Nobetci yok\n";
      }
    }
    mesaj2 += "`\n\n";
  });

  await telegramMesajGonder(mesaj2);
  return { success: true };
});

// ===========================
// BUGÜN NÖBETÇİ Mİ HESAPLAMA (paylaşılan yardımcı)
// nobetBugunKontrol (portal bildirimi, "bir daha gösterme" gorulme durumunu
// da kontrol eder) ve nobetciMiBugun (disiplin sayfası gibi yerler için,
// gorulme durumundan bağımsız saf kontrol) tarafından ortak kullanılır.
// ===========================
async function nobetBugunMu(db, teacherId) {
  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const jsDay = new Date(bugun + "T12:00:00").getDay();
  if (jsDay === 0 || jsDay === 6) return { nobetciMi: false };
  const bugunGi = jsDay - 1;

  const donemDurumu = await okulDonemDisindaMi(db, bugun);
  if (donemDurumu) return { nobetciMi: false };
  const bugunTatilAdi = await tatilKontrol(db, bugun);
  if (bugunTatilAdi) return { nobetciMi: false };

  const [nbDoc, nokDoc] = await Promise.all([
    db.collection("nobet2_ayarlar").doc("mevcut").get(),
    db.collection("nobet2_ayarlar").doc("noktalar").get(),
  ]);
  if (!nbDoc.exists) return { nobetciMi: false };

  const nb = nbDoc.data();
  const NOKTALAR = nokDoc.exists ? (nokDoc.data().liste || []) : [];
  const N = NOKTALAR.length;
  if (!N) return { nobetciMi: false };

  const slotlar = nb.slotlar || [];
  const teacherSlot = slotlar.find((s) => s.ogretmen_id === teacherId);
  if (!teacherSlot) return { nobetciMi: false };

  // Bugun, admin'in Ileri/Geri ile takip ettigi mevcut hafta icinde mi?
  const haftaBas = new Date(nb.hafta_baslangic + "T12:00:00");
  const haftaBit = new Date(haftaBas);
  haftaBit.setDate(haftaBas.getDate() + 4);
  const bugunTarih = new Date(bugun + "T12:00:00");
  if (bugunTarih < haftaBas || bugunTarih > haftaBit) return { nobetciMi: false };

  const sayac = nb.rotasyon_sayaci || 0;
  const pos = nobet2PozHesapla(teacherSlot, sayac, slotlar, N);
  if (pos.gi !== bugunGi) return { nobetciMi: false };

  return { nobetciMi: true, nokta: NOKTALAR[pos.ni] || "" };
}

// ===========================
// BUGÜN NÖBETÇİ MİSİN KONTROLÜ (Gün Değişme Nöbeti)
// Öğretmen girişinde çağrılır; rastgelelik gerektirmez ama rotasyon
// mantığının istemcide (henüz yüklenmemiş nobet2.html iframe'inde) yeniden
// hesaplanmasını gerektirmeyecek şekilde tamamen sunucu tarafında çalışır.
// ===========================
exports.nobetBugunKontrol = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const db = admin.firestore();

  const teacherSnap = await db.collection("teachers").where("uid", "==", request.auth.uid).limit(1).get();
  if (teacherSnap.empty) return { nobetciMi: false };
  const teacherId = teacherSnap.docs[0].id;

  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const gorulmeDoc = await db.collection("nobet_gorulme").doc(teacherId).get();
  if (gorulmeDoc.exists && gorulmeDoc.data().son_tarih === bugun) return { nobetciMi: false };

  return nobetBugunMu(db, teacherId);
});

// ===========================
// BUGÜN NÖBETÇİ Mİ (disiplin sayfası için)
// nobetBugunKontrol'den farkı: "bir daha gösterme" (nobet_gorulme) durumunu
// kontrol etmez, öğretmen portal bildirimini kapatmış olsa bile gün boyunca
// dogru sonuc doner.
// ===========================
exports.nobetciMiBugun = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const db = admin.firestore();

  const teacherSnap = await db.collection("teachers").where("uid", "==", request.auth.uid).limit(1).get();
  if (teacherSnap.empty) return { nobetciMi: false };
  const teacherId = teacherSnap.docs[0].id;

  return nobetBugunMu(db, teacherId);
});

// ===========================
// GÜNLÜK NÖBET BİLDİRİMİ (Telegram)
// Her sabah 07:30'da (hafta içi) o günün nöbetçi öğretmenlerini, nöbet
// noktalarını ve ders programında ara boşluğu olan öğretmenleri
// nobet_bildirim_alicilari listesindeki Telegram hesaplarına gönderir. Okul
// dönemi dışında veya tatil gününde bildirim gönderilmez.
// ===========================
async function nobetGunlukBildirimCalistir(db) {
  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const jsDay = new Date(bugun + "T12:00:00").getDay();
  if (jsDay === 0 || jsDay === 6) {
    console.log("Hafta sonu, nobet bildirimi gonderilmedi.");
    return { sebep: "Hafta sonu." };
  }

  const donemDurumu = await okulDonemDisindaMi(db, bugun);
  if (donemDurumu) {
    console.log(`${bugun} okul donemi disinda (${donemDurumu}), nobet bildirimi gonderilmedi.`);
    return { sebep: `Okul donemi disinda (${donemDurumu}).` };
  }
  const tatilAdi = await tatilKontrol(db, bugun);
  if (tatilAdi) {
    console.log(`${bugun} tatil donemine (${tatilAdi}) denk geliyor, nobet bildirimi gonderilmedi.`);
    return { sebep: `Tatil donemi: ${tatilAdi}.` };
  }

  const aliciSnap = await db.collection("nobet_bildirim_alicilari").get();
  const aliciListesi = aliciSnap.docs.map((d) => d.data()).filter((a) => a.chat_id);
  if (!aliciListesi.length) {
    console.log("Nobet bildirimi icin tanimli alici yok.");
    return { sebep: "Tanimli alici yok." };
  }

  const bugunGi = jsDay - 1;
  const [nbDoc, nokDoc, lessonsSnap, teachersSnap] = await Promise.all([
    db.collection("nobet2_ayarlar").doc("mevcut").get(),
    db.collection("nobet2_ayarlar").doc("noktalar").get(),
    db.collection("today_lessons").where("date", "==", bugun).get(),
    db.collection("teachers").get(),
  ]);

  const ogretmenAdMap = {};
  teachersSnap.forEach((d) => (ogretmenAdMap[d.id] = d.data().ad || d.id));

  let mesaj = `📋 <b>${bugun} - GÜNLÜK NÖBET BİLDİRİMİ</b>\n\n`;

  // ── Bugünün nöbetçileri ──
  mesaj += "🔔 <b>Bugünün Nöbetçileri</b>\n";
  const nb = nbDoc.exists ? nbDoc.data() : null;
  const NOKTALAR = nokDoc.exists ? (nokDoc.data().liste || []) : [];
  const N = NOKTALAR.length;
  if (nb && N) {
    const slotlar = nb.slotlar || [];
    const sayac = nb.rotasyon_sayaci || 0;
    const haftaBas = new Date(nb.hafta_baslangic + "T12:00:00");
    const haftaBit = new Date(haftaBas);
    haftaBit.setDate(haftaBas.getDate() + 4);
    const bugunTarih = new Date(bugun + "T12:00:00");
    const bugunHaftaIcinde = bugunTarih >= haftaBas && bugunTarih <= haftaBit;

    const bugunNobetciler = [];
    if (bugunHaftaIcinde) {
      slotlar.forEach((s) => {
        const pos = nobet2PozHesapla(s, sayac, slotlar, N);
        if (pos.gi === bugunGi) bugunNobetciler.push({ ni: pos.ni, ad: s.ogretmen_ad });
      });
    }
    if (bugunNobetciler.length) {
      bugunNobetciler.sort((a, b) => a.ni - b.ni);
      bugunNobetciler.forEach((n) => {
        mesaj += `• ${NOKTALAR[n.ni] || "-"}: ${n.ad}\n`;
      });
    } else {
      mesaj += "Bugün nöbetçi yok.\n";
    }
  } else {
    mesaj += "Nöbet çizelgesi tanımlı değil.\n";
  }

  // ── Ara boşluğu olan öğretmenler (sadece ders programına göre) ──
  mesaj += "\n🕳 <b>Ara Boşluğu Olan Öğretmenler</b>\n";
  const doluSaatler = {};
  lessonsSnap.forEach((d) => {
    const data = d.data();
    const tid = data.teacher_id;
    if (!tid) return;
    if (!doluSaatler[tid]) doluSaatler[tid] = new Set();
    doluSaatler[tid].add(data.lesson_number);
  });

  const bosluklar = [];
  Object.entries(doluSaatler).forEach(([tid, saatSet]) => {
    const saatler = [...saatSet].sort((a, b) => a - b);
    const ilk = saatler[0];
    const son = saatler[saatler.length - 1];
    const bosSaatler = [];
    for (let s = ilk + 1; s < son; s++) {
      if (!saatSet.has(s)) bosSaatler.push(s);
    }
    if (bosSaatler.length) {
      bosluklar.push({ ad: ogretmenAdMap[tid] || tid, bosSaatler });
    }
  });

  if (bosluklar.length) {
    bosluklar.sort((a, b) => a.ad.localeCompare(b.ad, "tr"));
    bosluklar.forEach((o) => {
      mesaj += `• ${o.ad}: ${o.bosSaatler.map((s) => s + ". ders").join(", ")}\n`;
    });
  } else {
    mesaj += "Bugün ara boşluğu olan öğretmen yok.\n";
  }

  // ── Raporlu öğretmenlerin bugünkü dersleri ──
  // Vekiller 07:00'de raporluOtomatikVekilAta ile atanir; burada atananlar ve
  // atanamayanlar listelenir.
  mesaj += "\n📌 <b>Raporlu Öğretmenlerin Dersleri</b>\n";
  const raporSnap = await db.collection("ogretmen_rapor").where("baslangic_tarihi", "<=", bugun).get();
  const bugunRaporluIds = new Set();
  raporSnap.forEach((d) => {
    const r = d.data();
    if (r.bitis_tarihi >= bugun) bugunRaporluIds.add(r.ogretmen_id);
  });

  if (!bugunRaporluIds.size) {
    mesaj += "Bugün raporlu öğretmen yok.\n";
  } else {
    const raporluDersler = [];
    lessonsSnap.forEach((d) => {
      const data = d.data();
      if (bugunRaporluIds.has(data.teacher_id)) raporluDersler.push(data);
    });
    raporluDersler.sort((a, b) => a.lesson_number - b.lesson_number);

    if (!raporluDersler.length) {
      mesaj += "Raporlu öğretmenlerin bugün dersi yok.\n";
    } else {
      raporluDersler.forEach((data) => {
        const raporluAd = ogretmenAdMap[data.teacher_id] || data.teacher_id;
        const ders = `${data.class_id} ${data.lesson_name || "-"} (${data.lesson_number}. ders): ${raporluAd}`;
        mesaj += data.substitute_teacher_id
          ? `✅ ${ders} → vekil: ${data.substitute_teacher_ad || ogretmenAdMap[data.substitute_teacher_id] || "?"}\n`
          : `⚠️ ${ders} — vekil atanamadı (Vekil Atama sekmesinden atayın)\n`;
      });
    }
  }

  const sonuclar = await Promise.all(
    aliciListesi.map(async (a) => {
      try {
        const r = await telegramMesajGonderKisiye(a.chat_id, mesaj);
        return { ad: a.ad, chat_id: a.chat_id, ok: !!r.ok, hata: r.ok ? null : (r.description || "Bilinmeyen hata") };
      } catch (err) {
        return { ad: a.ad, chat_id: a.chat_id, ok: false, hata: err.message };
      }
    })
  );
  sonuclar.filter((s) => !s.ok).forEach((s) => {
    console.error(`Nobet bildirimi gonderilemedi (${s.ad}, ${s.chat_id}): ${s.hata}`);
  });
  return { sonuclar };
}

exports.nobetGunlukBildirim = onSchedule(
  { schedule: "30 7 * * 1-5", timeZone: "Europe/Istanbul" },
  async () => { await nobetGunlukBildirimCalistir(admin.firestore()); }
);

// Admin panelinden 07:30'u beklemeden test amaçlı tetiklenebilir.
exports.nobetGunlukBildirimTest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const sonuc = await nobetGunlukBildirimCalistir(admin.firestore());
  return { success: true, sebep: sonuc?.sebep || null, sonuclar: sonuc?.sonuclar || [] };
});

// ===========================
// RAPORLU ÖĞRETMEN İÇİN VEKİL ATA
// Once bugun nobetci olup o saatte bos olan ogretmenleri (Tier 1), yoksa
// diger bos ogretmenleri (Tier 2) dener. Zaten vekili atanmis dersler
// varsayilan olarak atlanir; dersIdListesi verilirse sadece o ders(ler)
// icin zorla (mevcut atamayi degistirerek) yeniden atama yapilir.
// Admin panelinden (raporluIcinVekilAta) ve her okul sabahi otomatik
// (raporluOtomatikVekilAta) ayni fonksiyonla calisir.
// ===========================
exports.raporluIcinVekilAta = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }
  return raporluVekilAtaCalistir(admin.firestore(), request.data || {});
});

async function raporluVekilAtaCalistir(db, { ogretmenId, dersIdListesi } = {}) {
  const zorlaMod = Array.isArray(dersIdListesi) && dersIdListesi.length > 0;
  if (!ogretmenId && !zorlaMod) {
    throw new HttpsError("invalid-argument", "ogretmenId veya dersIdListesi gerekli.");
  }

  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const jsDay = new Date(bugun + "T12:00:00").getDay();
  if (jsDay === 0 || jsDay === 6) return { success: false, message: "Bugün hafta sonu." };

  const donemDurumu = await okulDonemDisindaMi(db, bugun);
  if (donemDurumu) return { success: false, message: "Okul dönemi dışında." };
  const tatilAdi = await tatilKontrol(db, bugun);
  if (tatilAdi) return { success: false, message: `Bugün tatil: ${tatilAdi}.` };
  const bugunGi = jsDay - 1;

  let hedefOgretmenId = ogretmenId;
  if (!hedefOgretmenId) {
    const ilkDers = await db.collection("today_lessons").doc(dersIdListesi[0]).get();
    if (!ilkDers.exists) throw new HttpsError("not-found", "Ders bulunamadı.");
    hedefOgretmenId = ilkDers.data().teacher_id;
  }

  const raporSnap = await db.collection("ogretmen_rapor").where("baslangic_tarihi", "<=", bugun).get();
  const bugunRaporluIds = new Set();
  let raporluAd = null;
  raporSnap.forEach((d) => {
    const r = d.data();
    if (r.bitis_tarihi >= bugun) {
      bugunRaporluIds.add(r.ogretmen_id);
      if (r.ogretmen_id === hedefOgretmenId) raporluAd = r.ogretmen_ad;
    }
  });
  if (!bugunRaporluIds.has(hedefOgretmenId)) {
    return { success: false, message: "Bu öğretmen bugün için raporlu değil." };
  }

  const [lessonsSnap, teachersSnap] = await Promise.all([
    db.collection("today_lessons").where("date", "==", bugun).get(),
    db.collection("teachers").get(),
  ]);
  const ogretmenAdMap = {};
  teachersSnap.forEach((d) => (ogretmenAdMap[d.id] = d.data().ad || d.id));
  if (!raporluAd) raporluAd = ogretmenAdMap[hedefOgretmenId] || hedefOgretmenId;

  const saatteBosOlanlar = saatBazliBosOgretmenler(lessonsSnap, ogretmenAdMap, bugunRaporluIds);
  const nobetciIdSeti = await bugunNobetciIdSeti(db, bugun, bugunGi);

  const hedefDersler = [];
  lessonsSnap.forEach((d) => {
    const data = d.data();
    if (data.teacher_id !== hedefOgretmenId) return;
    if (zorlaMod) {
      if (dersIdListesi.includes(d.id)) hedefDersler.push({ id: d.id, ref: d.ref, data });
    } else if (!data.substitute_teacher_id) {
      hedefDersler.push({ id: d.id, ref: d.ref, data });
    }
  });
  hedefDersler.sort((a, b) => a.data.lesson_number - b.data.lesson_number);

  if (!hedefDersler.length) {
    return {
      success: true, raporluAd, sonuclar: [],
      message: "Bugün için atanacak ders bulunamadı (henüz oluşturulmamış olabilir — Manuel Giriş sekmesinden oluşturabilirsiniz).",
    };
  }

  const gunIciAtamaSayaci = {};
  const buCalistirmadaAtananlar = {};
  const sonuclar = [];

  const secimYap = (adaylar) => {
    if (!adaylar.length) return null;
    const kopya = adaylar.slice();
    kopya.sort((a, b) => {
      const sa = gunIciAtamaSayaci[a.id] || 0;
      const sb = gunIciAtamaSayaci[b.id] || 0;
      return sa !== sb ? sa - sb : a.ad.localeCompare(b.ad, "tr");
    });
    return kopya[0];
  };

  for (const ders of hedefDersler) {
    const saat = ders.data.lesson_number;
    const zatenAtanan = buCalistirmadaAtananlar[saat] || new Set();
    const havuz = (saatteBosOlanlar[saat] || []).filter((a) => !zatenAtanan.has(a.id));

    let tier = "nobetci";
    let secilen = secimYap(havuz.filter((a) => nobetciIdSeti.has(a.id)));
    if (!secilen) {
      secilen = secimYap(havuz);
      tier = "diger";
    }

    if (!secilen) {
      sonuclar.push({
        dersId: ders.id, classId: ders.data.class_id, lessonName: ders.data.lesson_name || "",
        lessonNumber: saat, atandi: false,
      });
      continue;
    }

    gunIciAtamaSayaci[secilen.id] = (gunIciAtamaSayaci[secilen.id] || 0) + 1;
    if (!buCalistirmadaAtananlar[saat]) buCalistirmadaAtananlar[saat] = new Set();
    buCalistirmadaAtananlar[saat].add(secilen.id);

    await ders.ref.update({
      substitute_teacher_id: secilen.id,
      substitute_teacher_ad: secilen.ad,
      substitute_for_teacher_id: hedefOgretmenId,
      substitute_for_teacher_ad: raporluAd,
      substitute_assigned_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    sonuclar.push({
      dersId: ders.id, classId: ders.data.class_id, lessonName: ders.data.lesson_name || "",
      lessonNumber: saat, atandi: true, tier, vekilId: secilen.id, vekilAd: secilen.ad,
    });
  }

  return { success: true, raporluAd, sonuclar };
}

// ===========================
// RAPORLU ÖĞRETMENLERE OTOMATİK VEKİL ATA (her okul sabahı 07:00)
// 03:00'te bugunun dersleri olustuktan sonra, 07:30 nobet bildiriminden once
// calisir. Raporu bugunu kapsayan her ogretmen icin "Vekil Ata" ile ayni
// kurali uygular. Ogretmenler SIRAYLA islenir: her cagri today_lessons'i
// yeniden okuyup onceki atamalari dolu saat saydigi icin ayni vekil ayni
// saatte iki derse atanmaz. Vekili zaten olan dersler (elle atamalar) korunur.
// ===========================
exports.raporluOtomatikVekilAta = onSchedule(
  { schedule: "0 7 * * 1-5", timeZone: "Europe/Istanbul" },
  async () => {
    const db = admin.firestore();
    const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
    const raporSnap = await db.collection("ogretmen_rapor").where("baslangic_tarihi", "<=", bugun).get();
    const raporluIds = [...new Set(
      raporSnap.docs.map((d) => d.data()).filter((r) => r.bitis_tarihi >= bugun).map((r) => r.ogretmen_id),
    )];
    if (!raporluIds.length) {
      console.log("Otomatik vekil: bugun raporlu ogretmen yok.");
      return;
    }

    let atanan = 0, atanamayan = 0;
    for (const ogretmenId of raporluIds) {
      try {
        const r = await raporluVekilAtaCalistir(db, { ogretmenId });
        if (!r.success) {
          // Hafta sonu / tatil / donem disi: hicbir ogretmen icin calismaz.
          console.log(`Otomatik vekil atlandi: ${r.message}`);
          return;
        }
        const s = r.sonuclar || [];
        const a = s.filter((x) => x.atandi).length;
        atanan += a;
        atanamayan += s.length - a;
        console.log(`Otomatik vekil: ${r.raporluAd} — ${a} atandi, ${s.length - a} atanamadi`);
      } catch (err) {
        console.error(`Otomatik vekil hatasi (${ogretmenId}):`, err);
      }
    }
    console.log(`Otomatik vekil ozeti: ${raporluIds.length} raporlu ogretmen, ${atanan} ders atandi, ${atanamayan} ders atanamadi.`);
  },
);

// ===========================
// VEKİL DERS TELEFON BİLDİRİMİ
// Okul saatlerinde dakikada bir calisir. Bugun vekil atanmis ve dersi 5 dk
// icinde baslayacak (ya da gec atandigi icin en fazla 15 dk once baslamis)
// derslerin vekil ogretmenine push_tokenlari'ndaki cihazlarina bildirim ve
// zile (bildirimler) kayit gonderir. Ayni ders/vekil icin bir kez gonderilir;
// vekil degisirse yeni vekile tekrar gider.
// ===========================
const PORTAL_URL = "https://okul-yoklama-sistemi-8081f.web.app/portal.html";

// Verilen ogretmenlerin kayitli cihazlarina (push_tokenlari) telefon bildirimi
// gonderir; gecersiz/silinmis anahtarlari temizler. Firestore "in" sorgusu en
// fazla 30 deger aldigi icin anahtarlar 30'arli, FCM cagrisi 500'lu gruplarla.
// kalici: bildirim kullanici kapatana kadar ekranda kalsin (requireInteraction).
async function ogretmenlerePushGonder(db, ogretmenIds, { baslik, govde, tag, kalici = false }) {
  const idler = [...new Set(ogretmenIds)].filter(Boolean);
  const tokenlar = [];
  for (let i = 0; i < idler.length; i += 30) {
    const snap = await db.collection("push_tokenlari").where("teacher_id", "in", idler.slice(i, i + 30)).get();
    snap.forEach((t) => tokenlar.push(t.id));
  }
  let basarili = 0;
  for (let i = 0; i < tokenlar.length; i += 500) {
    const grup = tokenlar.slice(i, i + 500);
    try {
      const sonuc = await admin.messaging().sendEachForMulticast({
        tokens: grup,
        webpush: {
          notification: { title: baslik, body: govde, icon: "/icon.svg", tag, requireInteraction: kalici },
          fcmOptions: { link: PORTAL_URL },
        },
        data: { tag: tag || "" },
      });
      basarili += sonuc.successCount;
      await Promise.all(sonuc.responses.map((r, j) => {
        const kod = r.error?.code || "";
        if (kod === "messaging/registration-token-not-registered" || kod === "messaging/invalid-registration-token") {
          return db.collection("push_tokenlari").doc(grup[j]).delete().catch(() => {});
        }
        if (r.error) console.warn(`Push gonderilemedi: ${kod} ${r.error.message}`);
        return null;
      }));
    } catch (err) {
      console.error("Push hatasi:", err);
    }
  }
  return { cihaz: tokenlar.length, basarili };
}

// ===========================
// VEKİL DERS ONAY GEÇMİŞİ
// vekil_dersler'e her kayit acilisi (atama onayi / elle giris) ve silinmesi
// vekil_ders_gecmis'e degistirilemez bir satir olarak yazilir. Islemi yapan
// kisi tetikleyicinin auth baglamindan (authId) alinir; boylece silmeyi
// ogretmenin mi idarenin mi yaptigi da gorunur.
// ===========================
async function vekilGecmisYaz(db, event, islem) {
  const v = event.data?.data();
  if (!v) return;
  const uid = event.authType === "system" ? null : (event.authId || (islem !== "silindi" ? v.olusturan_uid : null));
  let yapanAd = "", yapanRol = "";
  if (uid) {
    const u = await db.collection("users").doc(uid).get().catch(() => null);
    yapanAd = u?.data()?.ad || "";
    yapanRol = u?.data()?.rol || "";
  }
  // Ogretmenin kendi gecmisini sorgulayabilmesi icin vekilin hesap kimligi.
  let vekilUid = null;
  if (v.vekil_ogretmen_id) {
    const t = await db.collection("teachers").doc(v.vekil_ogretmen_id).get().catch(() => null);
    vekilUid = t?.data()?.uid || null;
  }
  await db.collection("vekil_ders_gecmis").add({
    islem, // "onay" | "elle" | "silindi"
    kayit_id: event.params.kayitId,
    tarih: v.tarih || "",
    ders_no: v.ders_no ?? null,
    sinif: v.sinif || "",
    ders_adi: v.ders_adi || "",
    asil_ogretmen_ad: v.asil_ogretmen_ad || "",
    vekil_ogretmen_id: v.vekil_ogretmen_id || "",
    vekil_ogretmen_ad: v.vekil_ogretmen_ad || "",
    vekil_uid: vekilUid,
    yapan_uid: uid,
    yapan_ad: yapanAd || (uid ? "" : "Sistem"),
    yapan: !uid ? "sistem" : yapanRol === "ogretmen" ? "ogretmen" : "idare",
    zaman: admin.firestore.FieldValue.serverTimestamp(),
  });
}

exports.vekilDersOlusturuldu = onDocumentCreatedWithAuthContext("vekil_dersler/{kayitId}", async (event) => {
  const kaynak = event.data?.data()?.kaynak;
  await vekilGecmisYaz(admin.firestore(), event, kaynak === "ogretmen" ? "elle" : "onay");
});

exports.vekilDersSilindi = onDocumentDeletedWithAuthContext("vekil_dersler/{kayitId}", async (event) => {
  await vekilGecmisYaz(admin.firestore(), event, "silindi");
});

// ===========================
// İZİN GİRİLİNCE REHBER ÖĞRETMENE BİLDİRİM
// Izin rehber onayina dustugunde (durum beklemede_rehber) sinifin rehber
// ogretmenine zil bildirimi (tip izin_onay) yazar ve telefonuna bildirim
// gonderir. Portala girisinde ayrica "Onay Bekleyen Izin Talepleri" penceresi
// acilir (portal-teacher.js rehberIzinKontrolEt). Rehber onaylayinca/
// reddedince zil kaydi izin.html'de okundu yapilir.
// ===========================
exports.izinRehbereBildir = onDocumentCreated("izinler/{izinId}", async (event) => {
  const v = event.data?.data();
  if (!v || v.durum !== "beklemede_rehber" || !v.rehber_id) return;
  const db = admin.firestore();
  const tr = (t) => (t ? String(t).split("-").reverse().join(".") : "");
  const aralik = v.baslangic_tarih === v.bitis_tarih ? tr(v.baslangic_tarih) : `${tr(v.baslangic_tarih)} – ${tr(v.bitis_tarih)}`;
  const baslik = "📄 Onay bekleyen izin";
  const govde = `${v.ogrenci_ad || "Öğrenci"} (${v.sinif || "?"}) — ${aralik} izin talebi onayınızı bekliyor. Giren: ${v.olusturan_ogretmen_ad || "?"}`;

  await db.collection("bildirimler").add({
    alici_id: v.rehber_id,
    tip: "izin_onay",
    baslik,
    mesaj: govde,
    referans_id: event.params.izinId,
    okundu: false,
    tarih: admin.firestore.FieldValue.serverTimestamp(),
  });
  const push = await ogretmenlerePushGonder(db, [v.rehber_id], { baslik, govde, tag: "izin_" + event.params.izinId });
  console.log(`Izin bildirimi: ${v.rehber_ad || v.rehber_id} <- ${v.ogrenci_ad} (${v.sinif}), push ${push.basarili}/${push.cihaz}`);
});

// ===========================
// İDARE MESAJI GÖNDER (admin "Bildirim Gönder" sayfası)
// Secilen ogretmenlere zil bildirimi (bildirimler, tip idare_mesaji) yazar,
// kayitli cihazlarina telefon bildirimi gonderir ve idare_mesajlari'na arsiv
// kaydi birakir. Hedef (tumu/zumre/secili) istemcide ogretmen id'lerine
// cozulur; burada teachers ile dogrulanir.
// ===========================
exports.idareMesajiGonder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");
  const db = admin.firestore();
  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  const caller = callerDoc.data() || {};
  if (caller.rol !== "admin" && caller.rol !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const baslik = String(request.data?.baslik || "").trim();
  const mesaj = String(request.data?.mesaj || "").trim();
  const hedefOzet = String(request.data?.hedefOzet || "").trim().slice(0, 300);
  const istenen = Array.isArray(request.data?.ogretmenIds) ? request.data.ogretmenIds.map(String) : [];
  if (!baslik || baslik.length > 100) throw new HttpsError("invalid-argument", "Başlık 1-100 karakter olmalı.");
  if (!mesaj || mesaj.length > 1000) throw new HttpsError("invalid-argument", "Mesaj 1-1000 karakter olmalı.");

  const teachersSnap = await db.collection("teachers").get();
  const gecerli = new Set(teachersSnap.docs.map((d) => d.id));
  const alicilar = [...new Set(istenen)].filter((id) => gecerli.has(id));
  if (!alicilar.length) throw new HttpsError("invalid-argument", "Geçerli alıcı öğretmen yok.");

  const mesajRef = db.collection("idare_mesajlari").doc();
  const gonderenAd = caller.ad || "İdare";
  await mesajRef.set({
    baslik, mesaj, hedef_ozet: hedefOzet,
    alici_ids: alicilar, alici_sayisi: alicilar.length,
    gonderen_uid: request.auth.uid, gonderen_ad: gonderenAd,
    tarih: admin.firestore.FieldValue.serverTimestamp(),
  });

  for (let i = 0; i < alicilar.length; i += 400) {
    const batch = db.batch();
    alicilar.slice(i, i + 400).forEach((ogretmenId) => {
      batch.set(db.collection("bildirimler").doc(), {
        alici_id: ogretmenId,
        tip: "idare_mesaji",
        baslik,
        mesaj,
        gonderen_ad: gonderenAd,
        referans_id: mesajRef.id,
        okundu: false,
        tarih: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }

  const govde = mesaj.length > 150 ? mesaj.slice(0, 147) + "..." : mesaj;
  const push = await ogretmenlerePushGonder(db, alicilar, { baslik: "📢 " + baslik, govde, tag: mesajRef.id });
  await mesajRef.update({ push_cihaz: push.cihaz, push_basarili: push.basarili });
  console.log(`Idare mesaji: "${baslik}" -> ${alicilar.length} ogretmen, push ${push.basarili}/${push.cihaz}`);
  return { success: true, alici: alicilar.length, cihaz: push.cihaz, basarili: push.basarili };
});

const VEKIL_BILDIRIM_ONCE_DK = 5;
const VEKIL_BILDIRIM_GEC_DK = 15;

exports.vekilDersBildirimi = onSchedule(
  { schedule: "* 7-17 * * 1-5", timeZone: "Europe/Istanbul" },
  async () => {
    const db = admin.firestore();
    const simdi = new Date();
    const bugun = simdi.toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
    const [ss, dd] = simdi.toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(11, 16).split(":").map(Number);
    const simdiDk = ss * 60 + dd;

    const [saatDoc, dersSnap] = await Promise.all([
      db.collection("ders_saatleri").doc("varsayilan").get(),
      db.collection("today_lessons").where("date", "==", bugun).get(),
    ]);
    const saatler = saatDoc.exists ? (saatDoc.data().saatler || {}) : {};

    const gonderilecek = [];
    dersSnap.forEach((d) => {
      const v = d.data();
      if (!v.substitute_teacher_id || v.vekil_bildirim_gonderilen === v.substitute_teacher_id) return;
      const bas = String(saatler[v.lesson_number] || "");
      if (!/^\d{1,2}:\d{2}$/.test(bas)) return;
      const [h, m] = bas.split(":").map(Number);
      const kalan = h * 60 + m - simdiDk;
      if (kalan > VEKIL_BILDIRIM_ONCE_DK || kalan < -VEKIL_BILDIRIM_GEC_DK) return;
      gonderilecek.push({ ref: d.ref, id: d.id, v, kalan });
    });
    if (!gonderilecek.length) return;

    for (const { ref, id, v, kalan } of gonderilecek) {
      const ogretmenId = v.substitute_teacher_id;
      const zaman = kalan > 0 ? `${kalan} dk sonra` : kalan === 0 ? "Şimdi" : "Şu an (ders başladı)";
      const baslik = "🔄 Vekil dersiniz var";
      const govde = `${zaman}: ${v.lesson_number}. ders — ${v.class_id} ${v.lesson_name || ""} (${v.substitute_for_teacher_ad || "?"} yerine)`;

      const { cihaz: tokenSayisi, basarili } = await ogretmenlerePushGonder(db, [ogretmenId], {
        baslik, govde, tag: id, kalici: true,
      });

      await Promise.all([
        db.collection("bildirimler").add({
          alici_id: ogretmenId,
          tip: "vekil_ders",
          baslik,
          mesaj: govde,
          okundu: false,
          tarih: admin.firestore.FieldValue.serverTimestamp(),
        }),
        ref.update({
          vekil_bildirim_gonderilen: ogretmenId,
          vekil_bildirim_zamani: admin.firestore.FieldValue.serverTimestamp(),
          vekil_bildirim_cihaz: basarili,
        }),
      ]);
      console.log(`Vekil bildirimi: ${v.substitute_teacher_ad || ogretmenId} ${v.lesson_number}. ders ${v.class_id} — ${basarili}/${tokenSayisi} cihaz`);
    }
  },
);

// Verilen YYYY-MM-DD tarihinin ait oldugu haftanin Pazartesi'sini dondurur
// (public/nobet2.html pazartesiyeYuvarla ile ayni mantik, sunucu kopyasi).
function nobet2PazartesiyeYuvarla(tarihStr) {
  const d = new Date(tarihStr + "T12:00:00");
  const fark = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + fark);
  return d.toISOString().split("T")[0];
}

function nobet2TarihEkle(tarihStr, gun) {
  const d = new Date(tarihStr + "T12:00:00");
  d.setDate(d.getDate() + gun);
  return d.toISOString().split("T")[0];
}

// Haftanin 5 is gununun (Pzt-Cuma) TAMAMI tatil araligina denk geliyorsa
// true doner. Kismi tatil (haftanin bir kismi) rotasyon sayacini durdurmaz —
// sadece o gunler icin nobetci gosterilmez (bkz. nobetBugunKontrol/nobetTelegramGonder).
function nobet2HaftaTamamenTatilMi(haftaBasStr, tatiller) {
  for (let gi = 0; gi < 5; gi++) {
    const gunStr = nobet2TarihEkle(haftaBasStr, gi);
    const kapali = tatiller.some((t) => t.baslangic && t.bitis && gunStr >= t.baslangic && gunStr <= t.bitis);
    if (!kapali) return false;
  }
  return true;
}

// ===========================
// GUN DEGISME NOBETI - HAFTALIK OTOMATIK ILERLETME
// Her Pazartesi erken saatte calisir; hafta_baslangic'i gercek takvime
// yetistirir, tam-hafta tatillerinde rotasyon_sayaci'ni ILERLETMEDEN sadece
// takvimi gunceller, okul baslangicindan once/bitisinden sonra hicbir sey
// yapmaz. Manuel Ileri/Geri/Durdur butonlari bu dokumani yazmaya devam eder;
// bu fonksiyon sadece "otomatik ilerleme" kaynagidir, mevcut state modelini
// degistirmez.
// ===========================
exports.nobet2HaftaGuncelle = onSchedule({ schedule: "0 2 * * 1", timeZone: "Europe/Istanbul" }, async () => {
  const db = admin.firestore();
  const ayarDoc = await db.collection("settings").doc("genel").get();
  const ayar = ayarDoc.exists ? ayarDoc.data() : {};
  const okulBas = ayar.okul_baslangic_tarihi || null;
  const okulBit = ayar.okul_bitis_tarihi || null;

  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const bugunPzt = nobet2PazartesiyeYuvarla(bugun);

  if (okulBas && bugunPzt < okulBas) {
    console.log("Okul henuz baslamadi, nobet haftasi guncellenmedi.");
    return;
  }
  if (okulBit && bugunPzt > okulBit) {
    console.log("Okul donemi sona erdi, nobet haftasi guncellenmedi.");
    return;
  }

  const nbRef = db.collection("nobet2_ayarlar").doc("mevcut");
  const [nbDoc, tatilSnap] = await Promise.all([nbRef.get(), db.collection("tatil_donemleri").get()]);
  const tatiller = tatilSnap.docs.map((d) => d.data());

  let nb, ilkKurulum = false;
  if (!nbDoc.exists) {
    ilkKurulum = true;
    const baslangicHafta = okulBas ? nobet2PazartesiyeYuvarla(okulBas) : bugunPzt;
    nb = { hafta_baslangic: baslangicHafta, rotasyon_aktif: true, rotasyon_sayaci: 0, slotlar: [] };
  } else {
    nb = nbDoc.data();
  }

  let hafta = nb.hafta_baslangic;
  let sayac = nb.rotasyon_sayaci || 0;
  const aktif = nb.rotasyon_aktif !== false;
  let ilerledi = false;
  let guard = 0;

  while (hafta < bugunPzt && guard < 520) {
    guard++;
    const sonrakiHafta = nobet2TarihEkle(hafta, 7);
    if (okulBit && sonrakiHafta > okulBit) break;
    const tamTatil = nobet2HaftaTamamenTatilMi(sonrakiHafta, tatiller);
    hafta = sonrakiHafta;
    if (aktif && !tamTatil) sayac++;
    ilerledi = true;
  }

  if (ilkKurulum || ilerledi) {
    await nbRef.set(
      {
        ...nb,
        hafta_baslangic: hafta,
        rotasyon_sayaci: sayac,
        son_otomatik_guncelleme: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`Nobet haftasi guncellendi: ${hafta}, sayac=${sayac}`);
  }

  // Bu haftanin dagilimini gorevlendirme yazisi icin arsivle (varsa ezme).
  // nobet2.html yaziHtml/dagilimHesapla ile ayni yapi.
  try {
    const arsivRef = db.collection("nobet2_gorevlendirmeler").doc(hafta);
    if (!(await arsivRef.get()).exists) {
      const nokDoc = await db.collection("nobet2_ayarlar").doc("noktalar").get();
      const noktalar = nokDoc.exists ? (nokDoc.data().liste || []) : [];
      const N = noktalar.length;
      const slotlar = nb.slotlar || [];
      if (N && slotlar.length) {
        const GUN_TAM = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma"];
        const gunDurumu = GUN_TAM.map((_, gi) => {
          const g = nobet2TarihEkle(hafta, gi);
          if ((okulBas && g < okulBas) || (okulBit && g > okulBit)) return "Dönem Dışı";
          return tatiller.some((t) => t.baslangic && t.bitis && g >= t.baslangic && g <= t.bitis) ? "Tatil" : null;
        });
        const atamalar = [];
        slotlar.forEach((s) => {
          const p = nobet2PozHesapla(s, sayac, slotlar, N);
          if (gunDurumu[p.gi] || !noktalar[p.ni]) return;
          atamalar.push({
            gi: p.gi, gun: GUN_TAM[p.gi], tarih: nobet2TarihEkle(hafta, p.gi),
            ni: p.ni, nokta: noktalar[p.ni], ogretmen_id: s.ogretmen_id, ogretmen_ad: s.ogretmen_ad,
          });
        });
        await arsivRef.set({
          hafta, sayac, kaynak: "otomatik", atamalar, gunDurumu, noktalar,
          olusturma: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Nobet gorevlendirmesi arsivlendi: ${hafta} (${atamalar.length} atama)`);
      }
    }
  } catch (err) {
    console.error("Nobet gorevlendirme arsivi yazilamadi:", err);
  }
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
      const mesaj = `⚠️ <b>DİSİPLİN BİLDİRİMİ</b>\n\n` +
        `Ogrenci: ${htmlKacis(veri.ogrenci_ad)}\n` +
        `Sinif: ${htmlKacis(veri.sinif)}\n` +
        `Davranis: ${htmlKacis(veri.davranis)}\n` +
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

  const mesaj = `⚠️ <b>DİSİPLİN BİLDİRİMİ</b>\n\n` +
    `Ogrenci: ${htmlKacis(veri.ogrenci_ad)}\n` +
    `Sinif: ${htmlKacis(veri.sinif)}\n` +
    `Davranis: ${htmlKacis(veri.davranis)}\n` +
    `Tekrar Sayisi: ${kayitSnap.size} (Esik: ${esik})\n` +
    `Donem: ${veri.donem}. Donem`;
  await telegramMesajGonder(mesaj);
});

// ===========================
// HAFTALIK DİSİPLİN RAPORU (her Cuma 16:00)
// Bu haftanin Pazartesi 00:00'indan itibaren esigine ulasan (yani
// disiplinKaydiYazildiginda'nin anlik bildirim gonderdigi) ogrenci/davranis
// ciftlerini listeler. Onceki haftalarda esigi asmis olanlar dahil edilmez.
// Liste ayri bir log tutulmadan dogrudan disiplin_kayitlar'dan hesaplanir.
// ===========================
async function disiplinHaftalikRaporHazirla(db) {
  // Istanbul'a gore bugun ve bu haftanin Pazartesi'si (Turkiye sabit UTC+3)
  const bugun = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 10);
  const bugunUtc = new Date(bugun + "T00:00:00Z");
  const pztUtc = new Date(bugunUtc);
  pztUtc.setUTCDate(bugunUtc.getUTCDate() - ((bugunUtc.getUTCDay() + 6) % 7));
  const gunStr = (ofset) => {
    const d = new Date(pztUtc);
    d.setUTCDate(pztUtc.getUTCDate() + ofset);
    return d.toISOString().slice(0, 10);
  };
  const haftaGunleri = [0, 1, 2, 3, 4].map(gunStr);
  const haftaBas = new Date(haftaGunleri[0] + "T00:00:00+03:00");
  const haftaSon = new Date(gunStr(7) + "T00:00:00+03:00");
  const trTarih = (s) => s.split("-").reverse().join(".");

  const turSnap = await db.collection("disiplin_turleri").where("aktif", "==", true).get();
  const esikler = {};
  turSnap.forEach((d) => { esikler[d.data().ad] = d.data().esik; });

  const haftaSnap = await db.collection("disiplin_kayitlar")
    .where("tarih", ">=", haftaBas).where("tarih", "<", haftaSon).get();
  const anahtarlar = new Map();
  haftaSnap.forEach((d) => {
    const k = d.data();
    if (!k.ogrenci_no || !k.davranis || !k.donem || !esikler[k.davranis]) return;
    anahtarlar.set(`${k.ogrenci_no}|${k.davranis}|${k.donem}`, k);
  });

  const liste = [];
  await Promise.all([...anahtarlar.values()].map(async (k) => {
    const esik = esikler[k.davranis];
    const snap = await db.collection("disiplin_kayitlar")
      .where("ogrenci_no", "==", k.ogrenci_no)
      .where("davranis", "==", k.davranis)
      .where("donem", "==", k.donem).get();
    if (snap.size < esik) return;
    const zamanlar = snap.docs.map((d) => d.data().tarih?.toMillis?.() ?? 0).sort((a, b) => a - b);
    const esikAni = zamanlar[esik - 1];
    if (esikAni >= haftaBas.getTime() && esikAni < haftaSon.getTime()) {
      liste.push({ ad: k.ogrenci_ad || k.ogrenci_no, sinif: k.sinif || "-", davranis: k.davranis, sayi: snap.size, esik });
    }
  }));

  const baslik = `📋 <b>HAFTALIK DİSİPLİN RAPORU</b>\n${trTarih(haftaGunleri[0])} – ${trTarih(haftaGunleri[4])}\n\n`;

  if (!liste.length) {
    // Tum hafta tatil / okul donemi disindaysa hic mesaj gonderme
    let okulGunuVar = false;
    for (const g of haftaGunleri) {
      if (!(await okulDonemDisindaMi(db, g)) && !(await tatilKontrol(db, g))) { okulGunuVar = true; break; }
    }
    if (!okulGunuVar) return { gonderildi: false, sebep: "Bu hafta okul gunu yok, rapor gonderilmedi.", sayi: 0 };
    return { mesajlar: [baslik + "Bu hafta esik asimi olmadi."], sayi: 0 };
  }

  liste.sort((a, b) =>
    String(a.sinif).localeCompare(String(b.sinif), "tr", { numeric: true }) ||
    String(a.ad).localeCompare(String(b.ad), "tr"));

  const satirlar = [];
  let oncekiSinif = null;
  for (const o of liste) {
    if (o.sinif !== oncekiSinif) {
      if (oncekiSinif !== null) satirlar.push("");
      satirlar.push(`<b>${htmlKacis(o.sinif)}</b>`);
      oncekiSinif = o.sinif;
    }
    satirlar.push(`• ${htmlKacis(o.ad)} — ${htmlKacis(o.davranis)} (${o.sayi}/${o.esik})`);
  }
  const ogrenciSayisi = new Set(liste.map((o) => o.sinif + "|" + o.ad)).size;
  satirlar.push("", `Toplam: ${ogrenciSayisi} ogrenci, ${liste.length} esik asimi`);

  // Telegram mesaj siniri 4096 karakter — satir bazinda parcala
  const mesajlar = [];
  let parca = baslik;
  for (const s of satirlar) {
    if (parca.length + s.length + 1 > 4000) { mesajlar.push(parca); parca = ""; }
    parca += s + "\n";
  }
  if (parca.trim()) mesajlar.push(parca);
  return { mesajlar, sayi: liste.length };
}

async function disiplinHaftalikRaporGonder(db) {
  const sonuc = await disiplinHaftalikRaporHazirla(db);
  if (!sonuc.mesajlar) return sonuc;
  for (const m of sonuc.mesajlar) {
    const r = await telegramMesajGonder(m);
    if (!r?.ok) throw new Error(r?.description || "Telegram mesaji gonderilemedi");
  }
  return { gonderildi: true, sayi: sonuc.sayi };
}

exports.disiplinHaftalikRapor = onSchedule(
  { schedule: "0 16 * * 5", timeZone: "Europe/Istanbul" },
  async () => {
    const sonuc = await disiplinHaftalikRaporGonder(admin.firestore());
    console.log("Haftalik disiplin raporu:", JSON.stringify(sonuc));
  }
);

// Admin panelinden Cuma'yi beklemeden elle tetiklenebilir.
exports.disiplinHaftalikRaporTest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giris yapilmamis.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  try {
    const sonuc = await disiplinHaftalikRaporGonder(admin.firestore());
    return { success: true, ...sonuc };
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
});

// ===========================
// AKSAKLIK BİLDİRİMİ — ACİL OLANLAR TELEGRAM'A
// Ogretmenin aksaklik.html'den gonderdigi bildirimlerden oncelik "acil"
// olanlar aninda admin Telegram'ina iletilir; digerleri sadece panelde.
// ===========================
exports.aksaklikBildirildiginde = onDocumentCreated("aksakliklar/{id}", async (event) => {
  const veri = event.data?.data();
  if (!veri || veri.oncelik !== "acil") return;

  const mesaj = `🔴 <b>ACİL AKSAKLIK BİLDİRİMİ</b>\n\n` +
    `Tür: ${htmlKacis(veri.tur)}\n` +
    `Yer: ${htmlKacis(veri.yer)}\n` +
    `Bildiren: ${htmlKacis(veri.ogretmen_ad)}\n\n` +
    `${htmlKacis(veri.aciklama)}`;
  try {
    await telegramMesajGonder(mesaj);
  } catch (err) {
    console.error("Aksaklik Telegram hatasi:", err.message);
  }
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

  const donemDurumu = await okulDonemDisindaMi(db, tarih);
  if (donemDurumu) {
    return {
      success: false,
      message: donemDurumu === "baslamadi"
        ? "Bu tarih okul baslangicindan once, ders/yoklama oluşturulmadı."
        : "Bu tarih okul bitisinden sonra, ders/yoklama oluşturulmadı.",
    };
  }

  const tatilAdi = await tatilKontrol(db, tarih);
  if (tatilAdi) {
    return { success: false, message: `Bu tarih tatil dönemine denk geliyor: ${tatilAdi}. Ders/yoklama oluşturulmadı.` };
  }

  // Mevcut kayıtları oku (silmek yerine class_id+lesson_number ile eşleştirilip
  // korunacak — zaten yoklaması girilmiş (status:"filled") dersler sıfırlanmasın).
  const mevcutSnap = await db.collection("today_lessons")
    .where("date", "==", tarih)
    .get();
  const mevcutMap = new Map();
  mevcutSnap.forEach(doc => {
    const d = doc.data();
    mevcutMap.set(`${d.class_id}_${d.lesson_number}`, doc);
  });

  // schedule.day yazımı Excel kaynağına göre değişebildiğinden tüm program
  // çekilip normalizeGun ile karşılaştırılıyor (exact-match .where() yerine).
  const tumProgramSnap = await db.collection("schedule").get();
  const programDocs = tumProgramSnap.docs.filter(d => normalizeGun(d.data().day) === bugunAdi);

  if (programDocs.length === 0) {
    return { success: false, message: "Bu gün için ders programı yok." };
  }

  const gecerliAnahtarlar = new Set();
  const batch = db.batch();
  let eklenen = 0, korunan = 0;

  programDocs.forEach(doc => {
    const ders = doc.data();
    const anahtar = `${ders.class_id}_${ders.lesson_number}`;
    gecerliAnahtarlar.add(anahtar);
    const mevcutDoc = mevcutMap.get(anahtar);
    if (mevcutDoc) {
      // Zaten var (yoklaması girilmiş olabilir) — status'a ve ID'ye dokunma,
      // sadece güncel ders bilgisiyle senkronize et.
      batch.update(mevcutDoc.ref, {
        lesson_name: ders.lesson_name,
        teacher_id: ders.teacher_id,
      });
      korunan++;
    } else {
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
      eklenen++;
    }
  });

  // Programda artık karşılığı olmayan ve henüz yoklaması girilmemiş ("pending")
  // eski kayıtları temizle. status:"filled" olanlara — programdan çıkmış olsa
  // bile — dokunulmuyor; girilmiş bir yoklamayı kaybetmemek önceliklidir.
  mevcutMap.forEach((doc, anahtar) => {
    if (!gecerliAnahtarlar.has(anahtar) && doc.data().status !== "filled") {
      batch.delete(doc.ref);
    }
  });

  await batch.commit();
  return { success: true, message: `${eklenen} yeni ders eklendi, ${korunan} mevcut kayıt korundu.` };
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
// KURA ÇEK
// Öğretmenler arası adil çekiliş — rastgele seçim admin tarafından
// manipüle edilemesin diye sunucu tarafında (transaction içinde) yapılır.
// ===========================
exports.kuraCek = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const { torbaId, oturumId, gorev, cekenAd } = request.data;
  if (!torbaId || !oturumId || !gorev) {
    throw new HttpsError("invalid-argument", "Torba, oturum ve gorev zorunludur.");
  }

  const db = admin.firestore();
  const torbaRef = db.collection("kura_torbalari").doc(torbaId);
  const oturumRef = db.collection("kura_oturumlari").doc(oturumId);
  const cekilisRef = db.collection("kura_cekilisleri").doc();

  // Silinmis ogretmenlerin torbada kalmis olma ihtimaline karsi canli listeyle kesistir.
  const teachersSnap = await db.collection("teachers").get();
  const canliOgretmenIds = new Set(teachersSnap.docs.map((d) => d.id));

  let secilen, torbaAd, oturumAd;

  await db.runTransaction(async (tx) => {
    const [torbaDoc, oturumDoc] = await Promise.all([tx.get(torbaRef), tx.get(oturumRef)]);
    if (!torbaDoc.exists) throw new HttpsError("not-found", "Torba bulunamadi.");
    if (!oturumDoc.exists) throw new HttpsError("not-found", "Oturum bulunamadi.");

    const uyeler = torbaDoc.data().uyeler || [];
    const adaylar = uyeler
      .map((u, idx) => ({ ...u, _idx: idx }))
      .filter((u) => u.durum === "bekliyor" && canliOgretmenIds.has(u.ogretmen_id));

    if (!adaylar.length) {
      throw new HttpsError("failed-precondition", "Torbada cekilecek ogretmen kalmadi.");
    }

    secilen = adaylar[Math.floor(Math.random() * adaylar.length)];
    torbaAd = torbaDoc.data().ad || "";
    oturumAd = oturumDoc.data().ad || "";

    const guncelUyeler = uyeler.map((u, idx) =>
      idx === secilen._idx ? { ...u, durum: "cekildi" } : u
    );
    tx.update(torbaRef, { uyeler: guncelUyeler, guncelleme: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(cekilisRef, {
      oturum_id: oturumId,
      oturum_ad: oturumAd,
      torba_id: torbaId,
      torba_ad: torbaAd,
      ogretmen_id: secilen.ogretmen_id,
      ogretmen_ad: secilen.ogretmen_ad,
      gorev,
      cekilis_tarihi: admin.firestore.FieldValue.serverTimestamp(),
      cekilis_admin_id: request.auth.uid,
      cekilis_admin_ad: cekenAd || "",
    });
  });

  // Kisisel bildirim (Firestore) — hataya ragmen cekilisi geciriz kilmaz
  try {
    await db.collection("bildirimler").add({
      alici_id: secilen.ogretmen_id,
      tip: "kura",
      baslik: "Kura Sonucu",
      mesaj: `${oturumAd} - ${gorev}`,
      referans_id: cekilisRef.id,
      okundu: false,
      tarih: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Kura bildirimi yazma hatasi:", err.message);
  }

  // Telegram ozeti — hataya ragmen fonksiyonu dusurmez
  try {
    const mesaj =
      `🎲 <b>KURA SONUCU</b>\n\n` +
      `<b>Oturum:</b> ${oturumAd}\n` +
      `<b>Torba:</b> ${torbaAd}\n` +
      `<b>Çıkan:</b> ${secilen.ogretmen_ad}\n` +
      `<b>Görev:</b> ${gorev}`;
    await telegramMesajGonder(mesaj);
  } catch (err) {
    console.error("Kura Telegram hatasi:", err.message);
  }

  return { success: true, ogretmenAd: secilen.ogretmen_ad, cekilisId: cekilisRef.id };
});

// ===========================
// KURA ÇEKİLİŞİNİ GERİ AL
// Yanlış/istenmeyen bir çekilişi siler, öğretmeni torbaya geri koyar.
// ===========================
exports.kuraCekilisiGeriAl = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Giriş yapılmamış.");

  const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.data()?.rol;
  if (callerRole !== "admin" && callerRole !== "mudur_yardimcisi") {
    throw new HttpsError("permission-denied", "Yetkiniz yok.");
  }

  const { cekilisId } = request.data;
  if (!cekilisId) throw new HttpsError("invalid-argument", "cekilisId zorunludur.");

  const db = admin.firestore();
  const cekilisRef = db.collection("kura_cekilisleri").doc(cekilisId);

  await db.runTransaction(async (tx) => {
    const cekilisDoc = await tx.get(cekilisRef);
    if (!cekilisDoc.exists) throw new HttpsError("not-found", "Cekilis bulunamadi.");
    const cekilis = cekilisDoc.data();

    const torbaRef = db.collection("kura_torbalari").doc(cekilis.torba_id);
    const torbaDoc = await tx.get(torbaRef);
    if (torbaDoc.exists) {
      const uyeler = (torbaDoc.data().uyeler || []).map((u) =>
        u.ogretmen_id === cekilis.ogretmen_id ? { ...u, durum: "bekliyor" } : u
      );
      tx.update(torbaRef, { uyeler, guncelleme: admin.firestore.FieldValue.serverTimestamp() });
    }
    tx.delete(cekilisRef);
  });

  return { success: true };
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