import {
  db, auth, functions, bugun,
  getDocs, addDoc, updateDoc, deleteDoc, getDoc, setDoc,
  collection, query, where, orderBy, doc, serverTimestamp, Timestamp, httpsCallable,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { tarihBilgisiniGoster, baslangicDegerleriniAyarla } from "./portal-ui.js";
import { authBaslat } from "./portal-auth.js";
import { anasayfaYukle } from "./portal-admin.js";
import { dersleriniYukle, ogretmenGorevleriniYukle } from "./portal-teacher.js";
import { gorevSayfasiBaslat } from "./portal-gorev.js";
import { kazanimSayfasiYukle, kazanimlarimYukle } from "./portal-kazanim.js";
import { bildirimleriYukle } from "./portal-bildirim.js";
import "./portal-yoklama.js";

// Backward-compat namespace for portal-raporlar.js and portal-ayarlar.js
window.__portal = {
  db, auth, functions, bugun,
  getDocs, addDoc, updateDoc, deleteDoc, getDoc, setDoc,
  collection, query, where, orderBy, doc, serverTimestamp, Timestamp, httpsCallable,
  getTumOgretmenler: () => state.ogretmenler,
  getTumSiniflar: () => state.siniflar,
  getAktifRol: () => state.rol,
  getAktifOgretmenDoc: () => state.ogretmenDoc,
  getAktifKullanici: () => state.kullanici,
};

// Central page loader — called by sayfaGoster and ogretmenKareTikla
window.sayfaYukle = (id) => {
  if (id !== "yoklamalarim" && state.ymTimer) {
    clearInterval(state.ymTimer);
    state.ymTimer = null;
  }
  if (id !== "anasayfa" && state.takipInterval) {
    clearInterval(state.takipInterval);
    state.takipInterval = null;
  }
  if (id !== "dyk" && state.dykTimer) {
    clearInterval(state.dykTimer);
    state.dykTimer = null;
  }

  if (id === "anasayfa")          anasayfaYukle();
  else if (id === "derslerim")    dersleriniYukle();
  else if (id === "yoklamalarim") window.yoklamalarimYukle?.();
  else if (id === "dyk")          window.dykSayfasiYukle?.();
  else if (id === "dyk-admin")    window.dykAdminYukle?.();
  else if (id === "raporlar")     window.raporSayfasiBaslat?.();
  else if (id === "ayarlar")      window.ayarlarYukle?.();
  else if (id === "nobet")        window.nobetYukle?.();
  else if (id === "disiplin")     window.disiplinYukle?.();
  else if (id === "gorev")        gorevSayfasiBaslat();
  else if (id === "gorevlerim")   ogretmenGorevleriniYukle();
  else if (id === "kazanimlar")   kazanimSayfasiYukle();
  else if (id === "kazanimlarim") kazanimlarimYukle();
  else if (id === "oto-nobet")      _iframeYukle("oto-nobet",      "/oto-nobet.html");
  else if (id === "nobet2")         _iframeYukle("nobet2",         "/nobet2.html");
  else if (id === "yoklama-fisi")   _iframeYukle("yoklama-fisi",   "/yoklama-fisi.html");
  else if (id === "dyk-fisi")       _iframeYukle("dyk-fisi",       "/dyk-fisi.html");
  else if (id === "program-talebi") _iframeYukle("program-talebi", "/program-talebi.html");
  else if (id === "anket")          _iframeYukle("anket",          "/anket.html");
  else if (id === "ogrenci-profil") _iframeYukle("ogrenci-profil", "/ogrenci-profil.html");
  else if (id === "veri-import")    _iframeYukle("veri-import",    "/import.html");
  else if (id === "geziler")        _iframeYukle("geziler",        "/gezi.html");
  else if (id === "gezi-kayit")    _iframeYukle("gezi-kayit",    "/gezi-kayit.html");
};

// Populate shared dropdowns from loaded teachers/classes
function dropdownlariGuncelle() {
  const modalOgr = document.getElementById("modalOgretmen");
  if (modalOgr) {
    modalOgr.innerHTML = "";
    state.ogretmenler.forEach(
      (o) => (modalOgr.innerHTML += `<option value="${o.id}">${o.ad}</option>`),
    );
  }
  const manuelSinif = document.getElementById("manuelSinif");
  if (manuelSinif) {
    manuelSinif.innerHTML = '<option value="">Sinif secin...</option>';
    [...state.siniflar]
      .sort((a, b) => a.class_name.localeCompare(b.class_name))
      .forEach((s) => (manuelSinif.innerHTML += `<option value="${s.class_name}">${s.class_name}</option>`));
  }
}
window.dropdownlariGuncelle = dropdownlariGuncelle;

async function veriYukle() {
  const [ogSnap, sinSnap] = await Promise.all([
    getDocs(collection(db, "teachers")),
    getDocs(collection(db, "classes")),
  ]);
  state.ogretmenler = [];
  ogSnap.forEach((d) => state.ogretmenler.push({ id: d.id, ...d.data() }));
  state.siniflar = [];
  sinSnap.forEach((d) => state.siniflar.push({ id: d.id, ...d.data() }));
  dropdownlariGuncelle();
}
window.veriYenile = veriYukle;

// Initialize static UI
tarihBilgisiniGoster();
baslangicDegerleriniAyarla(bugun);

// Start auth
authBaslat(async (user, rol) => {
  await veriYukle();

  if (rol === "admin" || rol === "mudur_yardimcisi") {
    anasayfaYukle();
    document.getElementById("menu-anasayfa")?.classList.add("aktif");
    return;
  }

  if (rol === "ogrenci") {
    window.location.href = "/ogrenci.html";
    return;
  }

  // Öğretmen
  const ogSnap = await getDocs(
    query(collection(db, "teachers"), where("uid", "==", user.uid)),
  );
  if (!ogSnap.empty) {
    state.ogretmenDoc = { id: ogSnap.docs[0].id, ...ogSnap.docs[0].data() };
  }

  if (state.ogretmenDoc) {
    // Açık görev rozeti
    const gorevSnap = await getDocs(
      query(
        collection(db, "gorevler"),
        where("atanan_ids", "array-contains", state.ogretmenDoc.id),
        where("durum", "==", "acik"),
      ),
    );
    if (gorevSnap.size > 0) {
      const rozet = document.getElementById("rozet-gorevlerim");
      if (rozet) { rozet.textContent = gorevSnap.size; rozet.style.display = "inline"; }
    }
    bildirimleriYukle();
  }

  // Go to teacher grid home
  document.querySelectorAll(".sayfa").forEach((s) => s.classList.remove("aktif"));
  document.getElementById("sayfa-ogretmen-anasayfa").classList.add("aktif");
  document.getElementById("topbarBaslik").textContent = state.kullanici?.ad || "Ana Menü";
  document.getElementById("geriBtn").style.display = "none";
});

function _iframeYukle(sayfaId, src) {
  const div = document.getElementById("sayfa-" + sayfaId);
  if (!div || div.querySelector("iframe")) return;
  div.innerHTML = `<iframe src="${src}?embedded=1" style="width:100%;height:85vh;border:none;border-radius:12px;"></iframe>`;
}

window.nobetYukle    = () => _iframeYukle("nobet",    "/nobet.html");
window.disiplinYukle = () => _iframeYukle("disiplin", "/disiplin.html");

// Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
