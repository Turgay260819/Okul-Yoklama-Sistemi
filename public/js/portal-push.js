import { app, auth, db, doc, setDoc, deleteDoc, serverTimestamp } from "./portal-config.js";
import { state } from "./portal-state.js";
import {
  getMessaging, getToken, onMessage, isSupported,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// ── TELEFON BİLDİRİMLERİ (Firebase Cloud Messaging) ──
// Ogretmenin cihaz anahtari push_tokenlari/{token} belgesine yazilir; sunucu
// (vekilDersBildirimi) vekil ders saatinden 5 dk once bu anahtarlara gonderir.
// Izin tarayicida sadece bir kullanici tiklamasiyla istenebilir, bu yuzden
// izin verilmemisse ana ekranda bir "Bildirimleri ac" seridi gosterilir.

const TOKEN_ANAHTAR = "push_token";

function iosMu() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
function anaEkrandaMi() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function serit(html, tur = "bilgi") {
  const el = document.getElementById("pushSerit");
  if (!el) return;
  el.innerHTML = html;
  el.className = "push-serit push-serit-" + tur;
  el.hidden = false;
}
function seritGizle() {
  const el = document.getElementById("pushSerit");
  if (el) el.hidden = true;
}

async function tokenAlVeKaydet() {
  const kayit = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { serviceWorkerRegistration: kayit });
  if (!token) throw new Error("Bildirim anahtarı alınamadı.");

  const eski = localStorage.getItem(TOKEN_ANAHTAR);
  if (eski && eski !== token) await deleteDoc(doc(db, "push_tokenlari", eski)).catch(() => {});
  await setDoc(doc(db, "push_tokenlari", token), {
    token,
    uid: auth.currentUser.uid,
    teacher_id: state.ogretmenDoc.id,
    ogretmen_ad: state.ogretmenDoc.ad || "",
    cihaz: navigator.userAgent.slice(0, 200),
    guncelleme: serverTimestamp(),
  });
  try { localStorage.setItem(TOKEN_ANAHTAR, token); } catch {}

  // Portal acik ve on plandayken FCM bildirimi kendisi gostermez; biz gosteririz.
  onMessage(messaging, (p) => {
    const n = p.notification || {};
    kayit.showNotification(n.title || "Bildirim", { body: n.body || "", icon: "/icon.svg", tag: p.data?.tag });
  });
}

// Ogretmen girisinde cagrilir.
export async function pushHazirla() {
  if (!state.ogretmenDoc) return;
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !(await isSupported().catch(() => false))) {
    if (iosMu() && !anaEkrandaMi()) {
      serit(`📲 Vekil ders bildirimlerini almak için portalı ana ekrana ekleyin: Safari'de <strong>Paylaş → Ana Ekrana Ekle</strong>, sonra oradan açın.`);
    }
    return;
  }
  if (Notification.permission === "granted") {
    seritGizle();
    tokenAlVeKaydet().catch((e) => console.warn("Bildirim anahtari kaydedilemedi:", e));
  } else if (Notification.permission === "default") {
    serit(`📲 Vekil derslerinizden önce telefonunuza bildirim gelsin mi?
      <button class="btn btn-mavi btn-sm" onclick="pushIzinIste()">Bildirimleri aç</button>`);
  } else {
    serit("🔕 Bildirimler bu tarayıcıda engellenmiş. Açmak için tarayıcı ayarlarından bu site için bildirim iznini verin.", "uyari");
  }
}

window.pushIzinIste = async () => {
  try {
    const izin = await Notification.requestPermission();
    if (izin !== "granted") {
      serit("🔕 Bildirim izni verilmedi. Fikrinizi değiştirirseniz tarayıcı ayarlarından açabilirsiniz.", "uyari");
      return;
    }
    await tokenAlVeKaydet();
    serit("✅ Bildirimler açıldı. Vekil derslerinizden 5 dakika önce bildirim alacaksınız.", "basari");
    setTimeout(seritGizle, 5000);
  } catch (e) {
    serit("Bildirimler açılamadı: " + (e.message || e), "uyari");
  }
};

// Cikista bu cihazin anahtarini sil: ayni cihaza sonra baska kullanici girerse
// onceki ogretmenin bildirimleri gelmesin.
export async function pushAnahtariniSil() {
  let token = null;
  try { token = localStorage.getItem(TOKEN_ANAHTAR); } catch {}
  if (!token) return;
  await deleteDoc(doc(db, "push_tokenlari", token)).catch(() => {});
  try { localStorage.removeItem(TOKEN_ANAHTAR); } catch {}
}
