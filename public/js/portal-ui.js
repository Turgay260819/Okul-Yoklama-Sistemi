import { state } from "./portal-state.js";

const GUNLER = ["Pazar", "Pazartesi", "Sali", "Carsamba", "Persembe", "Cuma", "Cumartesi"];

export function tarihBilgisiniGoster() {
  const el = document.getElementById("tarihBilgi");
  if (!el) return;
  el.textContent =
    GUNLER[new Date().getDay()] +
    ", " +
    new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}

export function baslangicDegerleriniAyarla(bugun) {
  ["yoklamaTarih", "dykAdminTarih", "manuelTarih", "gorevSonTarih", "kilitTarih"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = bugun;
  });
}

// ── MENÜ ──
const adminMenu = [
  { id: "anasayfa",            ikon: "📊", ad: "Genel Durum" },
  { id: "yoklama-admin",       ikon: "📋", ad: "Gunluk Yoklamalar" },
  { id: "dyk-admin",           ikon: "📚", ad: "DYK Yoklamalari" },
  { id: "raporlar",            ikon: "📅", ad: "Raporlar" },
  { id: "oto-nobet-link",      ikon: "📅", ad: "Otomatik Nobet",       dis: "/oto-nobet.html" },
  { id: "nobet",               ikon: "🔔", ad: "Nobet Yonetimi" },
  { id: "nobet2-link",         ikon: "📅", ad: "Gun Degisme Nobeti",   dis: "/nobet2.html" },
  { id: "disiplin",            ikon: "📝", ad: "Disiplin" },
  { id: "gorev",               ikon: "👥", ad: "Gorev Dagilimi" },
  { id: "ayarlar",             ikon: "⚙️", ad: "Ayarlar" },
  { id: "fis-link",            ikon: "🖨",  ad: "Yoklama Fisleri",     dis: "/yoklama-fisi.html" },
  { id: "dyk-fis-link",        ikon: "🖨",  ad: "DYK Fisleri",         dis: "/dyk-fisi.html" },
  { id: "program-talebi-link", ikon: "📐", ad: "Program Talebi",       dis: "/program-talebi.html" },
  { id: "anket-link",          ikon: "📋", ad: "Anket & Formlar",      dis: "/anket.html" },
  { id: "ogrenci-profil-link", ikon: "👤", ad: "Ogrenci Profilleri",   dis: "/ogrenci-profil.html" },
  { id: "import-link",         ikon: "📥", ad: "Veri Import",          dis: "/import.html" },
  { id: "geziler-link",        ikon: "🚌", ad: "Geziler",              dis: "/gezi.html" },
  { id: "kazanimlar",          ikon: "📖", ad: "Kazanim Yonetimi" },
];

const ogretmenKareler = [
  { sayfa: 1, id: "derslerim",           ikon: "📋", ad: "Derslerim",           renk: "#e8f0fe", metinRenk: "#1a73e8" },
  { sayfa: 1, id: "yoklamalarim",        ikon: "✅", ad: "Yoklamalarım",         renk: "#e6f4ea", metinRenk: "#2e7d32" },
  { sayfa: 1, id: "dyk",                 ikon: "📚", ad: "DYK Yoklama",          renk: "#fce8e6", metinRenk: "#c62828" },
  { sayfa: 1, id: "disiplin",            ikon: "📝", ad: "Disiplin Kaydı",       renk: "#fff8e1", metinRenk: "#e65100" },
  { sayfa: 1, id: "gorevlerim",          ikon: "👥", ad: "Görevlerim",           renk: "#f3e8fd", metinRenk: "#6a1b9a" },
  { sayfa: 1, id: "kazanimlarim",        ikon: "📖", ad: "Kazanımlarım",         renk: "#e8f5e9", metinRenk: "#1b5e20" },
  { sayfa: 2, id: "manuel",             ikon: "✏️", ad: "Manuel Giriş",          renk: "#f5f5f5", metinRenk: "#424242" },
  { sayfa: 2, id: "nobet",              ikon: "🔔", ad: "Nöbet Programım",      renk: "#f5f5f5", metinRenk: "#424242" },
  { sayfa: 2, id: "oto-nobet-link",     ikon: "📅", ad: "Nöbet İsteğim",        renk: "#f5f5f5", metinRenk: "#424242", dis: "/oto-nobet.html" },
  { sayfa: 2, id: "ogrenci-profil-link",ikon: "👤", ad: "Öğrenci Profilleri",   renk: "#f5f5f5", metinRenk: "#424242", dis: "/ogrenci-profil.html" },
  { sayfa: 2, id: "program-talebi-link",ikon: "📐", ad: "Program Talebi",       renk: "#f5f5f5", metinRenk: "#424242", dis: "/program-talebi.html" },
  { sayfa: 2, id: "anket-link",         ikon: "📋", ad: "Anket & Formlar",      renk: "#f5f5f5", metinRenk: "#424242", dis: "/anket.html" },
];

let _ogrAktifSayfa = 0;

export function menuOlustur(rol) {
  if (rol !== "admin" && rol !== "mudur_yardimcisi") {
    document.body.classList.add("mod-ogretmen");
    ogretmenAnasayfaOlustur();
    return;
  }
  const container = document.getElementById("sidebarMenu");
  container.innerHTML = "";
  adminMenu.forEach((item) => {
    if (item.dis) {
      container.innerHTML += `<button class="menu-item" onclick="window.open('${item.dis}','_blank')"><span class="menu-ikon">${item.ikon}</span>${item.ad}</button>`;
    } else {
      container.innerHTML += `<button class="menu-item" id="menu-${item.id}" onclick="sayfaGoster('${item.id}','${item.ad}',this)"><span class="menu-ikon">${item.ikon}</span>${item.ad}<span class="menu-rozet" id="rozet-${item.id}" style="display:none;">0</span></button>`;
    }
  });
}

function ogretmenAnasayfaOlustur() {
  const s1 = document.getElementById("ogrSayfa1");
  const s2 = document.getElementById("ogrSayfa2");
  if (!s1 || !s2) return;
  s1.innerHTML = "";
  s2.innerHTML = "";
  ogretmenKareler.forEach((k) => {
    const hedef = k.sayfa === 1 ? s1 : s2;
    const onclick = k.dis
      ? `window.open('${k.dis}','_blank')`
      : `ogretmenKareTikla('${k.id}','${k.ad}')`;
    hedef.innerHTML +=
      `<div class="ogr-kare" style="background:${k.renk};" onclick="${onclick}">` +
      `<div class="ogr-kare-ikon">${k.ikon}</div>` +
      `<div class="ogr-kare-ad" style="color:${k.metinRenk};">${k.ad}</div>` +
      `</div>`;
  });
  // Touch swipe support
  const slider = document.getElementById("ogrSayfalar");
  let tx = 0;
  slider.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; }, { passive: true });
  slider.addEventListener("touchend", (e) => {
    const diff = tx - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) window.ogretmenSayfaDegistir(diff > 0 ? 1 : 0);
  }, { passive: true });
}

window.ogretmenSayfaDegistir = (idx) => {
  _ogrAktifSayfa = idx;
  const slider = document.getElementById("ogrSayfalar");
  if (slider) slider.style.transform = `translateX(${-idx * 50}%)`;
  document.querySelectorAll(".ogr-dot").forEach((d, i) => d.classList.toggle("aktif", i === idx));
};

window.ogretmenKareTikla = (sayfaId, ad) => {
  document.querySelectorAll(".sayfa").forEach((s) => s.classList.remove("aktif"));
  const sayfa = document.getElementById("sayfa-" + sayfaId);
  if (sayfa) sayfa.classList.add("aktif");
  document.getElementById("topbarBaslik").textContent = ad;
  document.getElementById("geriBtn").style.display = "flex";
  window.sayfaYukle(sayfaId);
};

window.ogretmenGeri = () => {
  document.querySelectorAll(".sayfa").forEach((s) => s.classList.remove("aktif"));
  document.getElementById("sayfa-ogretmen-anasayfa").classList.add("aktif");
  document.getElementById("topbarBaslik").textContent = state.kullanici?.ad || "Ana Menü";
  document.getElementById("geriBtn").style.display = "none";
};

window.sayfaGoster = (sayfaId, baslik, el) => {
  document.querySelectorAll(".sayfa").forEach((s) => s.classList.remove("aktif"));
  document.querySelectorAll(".menu-item").forEach((m) => m.classList.remove("aktif"));
  const sayfa = document.getElementById("sayfa-" + sayfaId);
  if (sayfa) sayfa.classList.add("aktif");
  if (el) el.classList.add("aktif");
  document.getElementById("topbarBaslik").textContent = baslik;
  window.sidebarKapat();
  window.sayfaYukle(sayfaId);
};

window.sidebarAc = () => {
  document.getElementById("sidebar").classList.add("acik");
  document.getElementById("sidebarOverlay").classList.add("aktif");
};
window.sidebarKapat = () => {
  document.getElementById("sidebar").classList.remove("acik");
  document.getElementById("sidebarOverlay").classList.remove("aktif");
};

window.akordiyonToggle = (id) => {
  const el = document.getElementById(id);
  const ok = document.getElementById("ok-" + id);
  if (!el) return;
  const acik = el.style.display !== "none";
  el.style.display = acik ? "none" : "block";
  if (ok) ok.textContent = acik ? "▶" : "▼";
};
