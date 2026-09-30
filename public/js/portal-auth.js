import {
  auth, db, bugun,
  doc, getDoc, getDocs, collection, query, where,
} from "./portal-config.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { state } from "./portal-state.js";
import { menuOlustur } from "./portal-ui.js";

export function authBaslat(onGiris) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      document.getElementById("girisEkrani").style.display = "flex";
      document.getElementById("uygulama").style.display = "none";
      return;
    }

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists()) { await signOut(auth); return; }

    state.kullanici = userDoc.data();
    state.rol = state.kullanici.rol;

    document.getElementById("girisEkrani").style.display = "none";
    document.getElementById("uygulama").style.display = "block";
    document.getElementById("kullaniciAd").textContent =
      state.kullanici.ad + " " + (state.kullanici.soyad || "");
    document.getElementById("kullaniciAvatar").textContent =
      state.kullanici.ad.charAt(0).toUpperCase();
    document.getElementById("kullaniciRol").textContent =
      state.rol === "admin" ? "Admin"
        : state.rol === "mudur_yardimcisi" ? "Mudur Yardimcisi"
        : state.rol === "idareci_izleyici" ? "İdareci (Görüntüleme)"
        : state.rol === "ogrenci" ? "Ogrenci"
        : "Ogretmen";

    // Salt-okunur idareci: admin ekranlarini gorur ama yazamaz (firestore.rules).
    if (state.rol === "idareci_izleyici" && !document.getElementById("saltOkunurSerit")) {
      const serit = document.createElement("div");
      serit.id = "saltOkunurSerit";
      serit.textContent = "👁 Görüntüleme modu — değişiklik yapamazsınız";
      serit.title = "Bu hesap sadece görüntüleme yetkisine sahip.";
      serit.style.cssText =
        "background:#fff3cd;color:#7a5b00;border:1px solid #f0d78c;border-radius:999px;" +
        "padding:4px 12px;font-size:12px;font-weight:600;white-space:nowrap;" +
        "overflow:hidden;text-overflow:ellipsis;min-width:0;";
      const topbarSag = document.querySelector(".topbar-sag");
      topbarSag?.parentNode.insertBefore(serit, topbarSag);
    }

    menuOlustur(state.rol);
    await onGiris(user, state.rol);
  });
}

window.girisYap = async () => {
  const email = document.getElementById("girisEmail").value.trim();
  const sifre = document.getElementById("girisSifre").value;
  const hata = document.getElementById("girisHata");
  hata.style.display = "none";
  if (!email || !sifre) {
    hata.textContent = "Email ve sifre girin.";
    hata.style.display = "block";
    return;
  }
  try {
    await signInWithEmailAndPassword(auth, email, sifre);
  } catch {
    hata.textContent = "Email veya sifre yanlis.";
    hata.style.display = "block";
  }
};

window.cikisYap = async () => { await signOut(auth); };
