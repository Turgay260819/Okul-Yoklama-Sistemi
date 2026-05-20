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
        : state.rol === "ogrenci" ? "Ogrenci"
        : "Ogretmen";

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
