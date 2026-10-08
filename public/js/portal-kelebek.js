import {
  db, functions, httpsCallable, bugunHesapla,
  getDocs, getDoc, addDoc, setDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor, normalizeGun } from "./portal-utils.js";
import { xlsxYukle, sayfaOlustur, dosyaAdi } from "./portal-excel.js";
import { kelebekDagit, kelebekIstatistik, kademeAl } from "./kelebek-dagit.js";

// ── KELEBEK SINAV ──
// Admin sinav olusturur: sube secimi, salonlar (mevcut siniflar ya da elle),
// kelebek dagitimi (kelebek-dagit.js), istege bagli sira no. Gozetmenler her
// acilista programdan hesaplanir (o tarih+saat+salon sinifinda dersi olan;
// vekil varsa vekil); kaydedilen sadece adminin elle yaptigi degisiklikler
// (gozetmenler["salon|saat"]). Idare goruntuler; sadece admin duzenler.

const GUNLER = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];
const DIGER = "__diger";

let _ogrenciler = null;   // tum aktif ogrenciler (ilk acilista)
let _program = null;      // schedule (ilk ihtiyacta)
let _okulAd = "AHMET YENİCE ORTAOKULU MÜDÜRLÜĞÜ";
let _sinav = null;        // duzenlenen sinav
let _dagilimEski = false; // ogrenci/salon degisti, dagilim guncel degil
let _gozetmen = {};       // "salon|saat" -> { id, ad, raporlu, kaynak, asil_id, asil_ad }

const admin = () => state.rol === "admin";
const kok = () => document.getElementById("sayfa-kelebek");
const ogretmenAd = (id) => state.ogretmenler.find((o) => o.id === id)?.ad || "";
const trTarih = (t) => { const [y, m, d] = String(t || "").split("-"); return d ? `${d}.${m}.${y}` : ""; };
const saatMetni = (s) => (s || []).map((x) => x + ".").join(", ") + " ders";

export async function kelebekYukle() {
  kok().innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    if (!_ogrenciler) {
      const snap = await getDocs(query(collection(db, "students"), where("status", "==", "active")));
      _ogrenciler = snap.docs.map((d) => {
        const o = d.data();
        return { ogrenci_id: d.id, no: String(o.student_number || ""), ad: o.name || "", sinif: o.class_id || "" };
      }).filter((o) => o.sinif);
      try {
        const y = await getDoc(doc(db, "nobet2_ayarlar", "yazi"));
        if (y.exists() && y.data().okul) _okulAd = y.data().okul;
      } catch (e) { /* varsayilan */ }
    }
    _sinav = null;
    await _listeCiz();
  } catch (err) {
    kok().innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.kelebekYukle = kelebekYukle;

// ═══════════ SINAV LİSTESİ ═══════════
async function _listeCiz() {
  const snap = await getDocs(collection(db, "kelebek_sinavlar"));
  const liste = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.tarih || "").localeCompare(a.tarih || ""));
  kok().innerHTML = `<div class="kart">
    <div class="kart-baslik-satir"><div class="kart-baslik">🦋 Kelebek Sınavlar</div>
      ${admin() ? '<button class="btn btn-yesil btn-sm" onclick="kelebekYeni()">➕ Yeni Sınav</button>' : ""}</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Öğrenciler salonlara aynı şubeden olanlar mümkün olduğunca bir arada olmayacak şekilde dağıtılır. Gözetmenler, sınav saatlerinde o salonda (sınıfta) dersi olan öğretmenlerdir.</p>
    ${liste.length ? `<div style="overflow-x:auto;"><table><thead><tr><th>Tarih</th><th>Sınav</th><th>Saat</th><th>Öğrenci</th><th>Salon</th><th></th></tr></thead><tbody>
      ${liste.map((s) => `<tr><td style="white-space:nowrap;">${esc(trTarih(s.tarih))}</td><td><strong>${esc(s.ad)}</strong>${s.sira_no ? ' <span class="rozet rozet-mavi" style="font-size:11px;">sıra no</span>' : ""}</td>
        <td style="white-space:nowrap;">${esc(saatMetni(s.saatler))}</td><td>${(s.dagilim || []).length}</td><td>${(s.salonlar || []).length}</td>
        <td style="white-space:nowrap;"><button class="btn btn-mavi btn-sm" data-id="${esc(s.id)}" onclick="kelebekAc(this.dataset.id)">Aç</button>
        ${admin() ? `<button class="btn btn-kirmizi btn-sm" data-id="${esc(s.id)}" onclick="kelebekSil(this.dataset.id)">Sil</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : '<div class="bos-mesaj">Henüz kelebek sınav yok.</div>'}
  </div>`;
}

window.kelebekYeni = () => {
  _sinav = { id: null, ad: "", tarih: bugunHesapla(), saatler: [], sira_no: false, siniflar: [], haric: [],
    salonlar: [{ ad: "", sinif: "", kapasite: 0 }], dagilim: [], gozetmenler: {} };
  _dagilimEski = false;
  _duzenleyiciCiz();
};

window.kelebekAc = async (id) => {
  const d = await getDoc(doc(db, "kelebek_sinavlar", id));
  if (!d.exists()) return;
  _sinav = { id, gozetmenler: {}, haric: [], dagilim: [], ...d.data() };
  _dagilimEski = false;
  _duzenleyiciCiz();
};

window.kelebekSil = async (id) => {
  if (!await sor("Sınavı Sil", "Bu kelebek sınav ve dağılımı silinecek.", "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "kelebek_sinavlar", id));
  await _listeCiz();
};

window.kelebekListeyeDon = () => { _sinav = null; _listeCiz(); };

// ═══════════ DÜZENLEYİCİ ═══════════
function _secilenOgrenciler() {
  const siniflar = new Set(_sinav.siniflar);
  const haric = new Set(_sinav.haric);
  return _ogrenciler.filter((o) => siniflar.has(o.sinif) && !haric.has(o.ogrenci_id));
}

function _subeSayilari() {
  const say = {};
  _ogrenciler.forEach((o) => (say[o.sinif] = (say[o.sinif] || 0) + 1));
  return say;
}

function _duzenleyiciCiz() {
  const ro = !admin();
  const dis = ro ? " disabled" : "";
  kok().innerHTML = `
    <div style="margin-bottom:10px;"><button class="btn btn-gri btn-sm" onclick="kelebekListeyeDon()">← Sınav listesi</button></div>
    <div class="kart"><div class="kart-baslik">1. Sınav Bilgileri</div>
      <div class="form-grid">
        <div class="form-group"><label>Sınav Adı</label><input id="kbAd" value="${esc(_sinav.ad)}" oninput="kelebekAlan('ad', this.value)"${dis}></div>
        <div class="form-group"><label>Tarih</label><input type="date" id="kbTarih" value="${esc(_sinav.tarih)}" onchange="kelebekAlan('tarih', this.value)"${dis}></div>
      </div>
      <label style="font-size:13px;font-weight:600;">Ders saatleri</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 10px;">
        ${[1, 2, 3, 4, 5, 6, 7, 8].map((s) => `<label style="display:flex;gap:4px;align-items:center;font-size:13px;">
          <input type="checkbox" value="${s}" ${_sinav.saatler.includes(s) ? "checked" : ""} onchange="kelebekSaat(${s}, this.checked)"${dis}>${s}. ders</label>`).join("")}
      </div>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px;">
        <input type="checkbox" id="kbSiraNo" ${_sinav.sira_no ? "checked" : ""} onchange="kelebekAlan('sira_no', this.checked)"${dis}>
        <strong>Sıra numarası verilsin</strong> <span style="color:var(--text2);">(önemli sınavlar için; yan yana oturanlar farklı şubeden olur)</span></label>
    </div>
    <div class="kart"><div class="kart-baslik">2. Sınava Girecek Öğrenciler</div><div id="kbOgrenciler"></div></div>
    <div class="kart"><div class="kart-baslik">3. Sınav Salonları</div><div id="kbSalonlar"></div></div>
    <div class="kart"><div class="kart-baslik">4. Dağıtım</div><div id="kbDagitim"></div></div>
    <div class="kart"><div class="kart-baslik">5. Gözetmenler</div><div id="kbGozetmen"></div></div>
    <div class="kart"><div class="kart-baslik">6. Çıktılar</div><div id="kbCikti"></div></div>
    <div class="mesaj" id="kbMesaj"></div>`;
  _ogrencilerCiz();
  _salonlarCiz();
  _dagitimCiz();
  _gozetmenYukle();
  _ciktiCiz();
}

window.kelebekAlan = (alan, deger) => {
  _sinav[alan] = deger;
  if (alan === "tarih") _gozetmenYukle();
  if (alan === "sira_no") _dagilimDegisti();
};
window.kelebekSaat = (s, acik) => {
  _sinav.saatler = acik ? [...new Set([..._sinav.saatler, s])].sort((a, b) => a - b) : _sinav.saatler.filter((x) => x !== s);
  _gozetmenYukle();
};

function _dagilimDegisti() {
  if (_sinav.dagilim.length) _dagilimEski = true;
  _dagitimCiz();
  _ciktiCiz();
}

// ── Öğrenciler ──
function _ogrencilerCiz() {
  const el = document.getElementById("kbOgrenciler");
  const ro = !admin();
  const say = _subeSayilari();
  const subeler = Object.keys(say).sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
  const kademeler = {};
  subeler.forEach((s) => (kademeler[kademeAl(s)] ||= []).push(s));
  const secili = new Set(_sinav.siniflar);
  const haricListe = _ogrenciler.filter((o) => _sinav.haric.includes(o.ogrenci_id));
  el.innerHTML = Object.entries(kademeler).map(([k, liste]) => {
    const hepsi = liste.every((s) => secili.has(s));
    return `<div style="margin-bottom:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;">
      <label style="font-weight:700;display:flex;gap:6px;align-items:center;margin-bottom:4px;">
        <input type="checkbox" ${hepsi ? "checked" : ""} data-k="${esc(k)}" onchange="kelebekKademe(this.dataset.k, this.checked)"${ro ? " disabled" : ""}>${esc(k)}. sınıflar</label>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">${liste.map((s) => `<label style="display:flex;gap:4px;align-items:center;font-size:13px;">
        <input type="checkbox" ${secili.has(s) ? "checked" : ""} data-s="${esc(s)}" onchange="kelebekSube(this.dataset.s, this.checked)"${ro ? " disabled" : ""}>
        ${esc(s)} <span style="color:var(--text2);">(${say[s]})</span></label>`).join("")}</div></div>`;
  }).join("") + `
    ${ro ? "" : `<div class="form-group" style="margin-top:8px;"><label>Öğrenci çıkar (sınava girmeyecek)</label>
      <input type="search" id="kbHaricAra" placeholder="Ad veya numara..." oninput="kelebekHaricAra(this.value)">
      <div id="kbHaricSonuc"></div></div>`}
    ${haricListe.length ? `<div style="font-size:13px;margin-top:6px;">Çıkarılanlar: ${haricListe.map((o) => `<span class="rozet rozet-gri" style="margin:2px;">${esc(o.ad)} (${esc(o.sinif)})${ro ? "" : ` <a href="#" data-id="${esc(o.ogrenci_id)}" onclick="kelebekHaricKaldir(this.dataset.id);return false;">✕</a>`}</span>`).join("")}</div>` : ""}
    <div style="margin-top:8px;font-weight:700;">Toplam: ${_secilenOgrenciler().length} öğrenci, ${_sinav.siniflar.length} şube</div>`;
}

window.kelebekKademe = (k, acik) => {
  const subeler = Object.keys(_subeSayilari()).filter((s) => kademeAl(s) === k);
  const set = new Set(_sinav.siniflar);
  subeler.forEach((s) => (acik ? set.add(s) : set.delete(s)));
  _sinav.siniflar = [...set];
  _ogrencilerCiz(); _salonlarCiz(); _dagilimDegisti();
};
window.kelebekSube = (s, acik) => {
  const set = new Set(_sinav.siniflar);
  acik ? set.add(s) : set.delete(s);
  _sinav.siniflar = [...set];
  _ogrencilerCiz(); _salonlarCiz(); _dagilimDegisti();
};
window.kelebekHaricAra = (q) => {
  const el = document.getElementById("kbHaricSonuc");
  const m = q.trim().toLocaleLowerCase("tr");
  if (!m) { el.innerHTML = ""; return; }
  const bul = _secilenOgrenciler().filter((o) => o.ad.toLocaleLowerCase("tr").includes(m) || o.no.includes(m)).slice(0, 8);
  el.innerHTML = bul.length ? bul.map((o) => `<div class="ogrenci-satir" style="cursor:pointer;padding:6px 10px;" data-id="${esc(o.ogrenci_id)}" onclick="kelebekHaricEkle(this.dataset.id)">
    <span class="ogrenci-no">${esc(o.no)}</span><span class="ogrenci-isim">${esc(o.ad)}</span><span class="rozet rozet-mavi" style="margin-left:auto;">${esc(o.sinif)}</span></div>`).join("")
    : '<div style="font-size:13px;color:var(--text2);">Seçili şubelerde bulunamadı.</div>';
};
window.kelebekHaricEkle = (id) => {
  if (!_sinav.haric.includes(id)) _sinav.haric.push(id);
  _ogrencilerCiz(); _salonlarCiz(); _dagilimDegisti();
};
window.kelebekHaricKaldir = (id) => {
  _sinav.haric = _sinav.haric.filter((x) => x !== id);
  _ogrencilerCiz(); _salonlarCiz(); _dagilimDegisti();
};

// ── Salonlar ──
function _salonAd(s) {
  return s.sinif && s.sinif !== DIGER ? s.sinif : (s.ad || "").trim();
}

function _salonlarCiz() {
  const el = document.getElementById("kbSalonlar");
  const ro = !admin();
  const siniflar = state.siniflar.map((s) => s.class_name).filter(Boolean).sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
  const toplamKap = _sinav.salonlar.reduce((a, s) => a + (Number(s.kapasite) || 0), 0);
  const ogrSayi = _secilenOgrenciler().length;
  el.innerHTML = `<p style="font-size:13px;color:var(--text2);margin-bottom:8px;">Mevcut bir sınıfı seçin ya da "Diğer" ile farklı bir salon (ör. Konferans Salonu) ekleyin; her salona kaç öğrenci gireceğini yazın. Diğer salonlara otomatik gözetmen atanmaz.</p>
    ${_sinav.salonlar.map((s, i) => `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
      <select data-i="${i}" onchange="kelebekSalonSinif(${i}, this.value)" style="min-width:140px;"${ro ? " disabled" : ""}>
        <option value="">Salon seçin...</option>
        ${siniflar.map((c) => `<option value="${esc(c)}" ${s.sinif === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
        <option value="${DIGER}" ${s.sinif === DIGER ? "selected" : ""}>Diğer (elle ad)</option>
      </select>
      ${s.sinif === DIGER ? `<input placeholder="Salon adı" value="${esc(s.ad)}" oninput="kelebekSalonAd(${i}, this.value)" style="width:170px;"${ro ? " disabled" : ""}>` : ""}
      <input type="number" min="0" placeholder="Öğrenci sayısı" value="${Number(s.kapasite) || ""}" oninput="kelebekSalonKap(${i}, this.value)" style="width:120px;"${ro ? " disabled" : ""}>
      ${ro ? "" : `<button class="btn btn-kirmizi btn-sm" onclick="kelebekSalonSil(${i})">Sil</button>`}
    </div>`).join("")}
    ${ro ? "" : '<button class="btn btn-gri btn-sm" onclick="kelebekSalonEkle()">➕ Salon ekle</button>'}
    <div id="kbKapasite" style="margin-top:8px;font-weight:700;color:${toplamKap < ogrSayi ? "#ea4335" : "inherit"};">
      Toplam yer: ${toplamKap} · Öğrenci: ${ogrSayi}${toplamKap < ogrSayi ? ` — ${ogrSayi - toplamKap} kişilik yer eksik` : ""}</div>`;
}

window.kelebekSalonSinif = (i, v) => {
  _sinav.salonlar[i].sinif = v;
  if (v !== DIGER) _sinav.salonlar[i].ad = v;
  _salonlarCiz(); _dagilimDegisti(); _gozetmenYukle();
};
window.kelebekSalonAd = (i, v) => { _sinav.salonlar[i].ad = v; _dagilimDegisti(); };
window.kelebekSalonKap = (i, v) => {
  _sinav.salonlar[i].kapasite = Math.max(0, parseInt(v, 10) || 0);
  const el = document.getElementById("kbKapasite");
  const toplamKap = _sinav.salonlar.reduce((a, s) => a + (Number(s.kapasite) || 0), 0);
  const ogrSayi = _secilenOgrenciler().length;
  el.style.color = toplamKap < ogrSayi ? "#ea4335" : "inherit";
  el.textContent = `Toplam yer: ${toplamKap} · Öğrenci: ${ogrSayi}${toplamKap < ogrSayi ? ` — ${ogrSayi - toplamKap} kişilik yer eksik` : ""}`;
  _dagilimDegisti();
};
window.kelebekSalonEkle = () => { _sinav.salonlar.push({ ad: "", sinif: "", kapasite: 0 }); _salonlarCiz(); };
window.kelebekSalonSil = (i) => { _sinav.salonlar.splice(i, 1); _salonlarCiz(); _dagilimDegisti(); _gozetmenYukle(); };

function _gecerliSalonlar() {
  return _sinav.salonlar.map((s) => ({ ad: _salonAd(s), sinif: s.sinif && s.sinif !== DIGER ? s.sinif : null, kapasite: Number(s.kapasite) || 0 }))
    .filter((s) => s.ad);
}

// ── Dağıtım ──
function _dagitimCiz() {
  const el = document.getElementById("kbDagitim");
  if (!el) return;
  const d = _sinav.dagilim;
  let html = admin() ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
    <button class="btn btn-mavi" onclick="kelebekDagitYap()">${d.length ? "🔀 Yeniden dağıt" : "🦋 Dağıt"}</button>
    <button class="btn btn-yesil" onclick="kelebekKaydet()">💾 Kaydet</button></div>` : "";
  if (_dagilimEski) html += '<div class="uyari-kutu-sm">Öğrenci, salon ya da sıra numarası seçimi değişti; yeniden dağıtın.</div>';
  if (!d.length) { el.innerHTML = html + '<div class="bos-mesaj">Henüz dağıtım yapılmadı.</div>'; return; }
  const salonlar = [...new Set(d.map((x) => x.salon))].map((ad) => ({ ad, kapasite: _gecerliSalonlar().find((s) => s.ad === ad)?.kapasite ?? "" }));
  const ist = kelebekIstatistik(d, salonlar);
  html += `<div style="overflow-x:auto;"><table><thead><tr><th>Salon</th><th>Öğrenci</th><th>Şube dağılımı</th><th>En çok aynı şube</th>${_sinav.sira_no ? "<th>Yan yana aynı şube</th>" : ""}</tr></thead><tbody>
    ${ist.map((s) => `<tr><td><strong>${esc(s.salon)}</strong></td><td>${s.sayi}${s.kapasite !== "" ? "/" + s.kapasite : ""}</td>
      <td style="font-size:12px;">${Object.entries(s.subeler).sort((a, b) => a[0].localeCompare(b[0], "tr", { numeric: true })).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ")}</td>
      <td style="text-align:center;">${s.enBuyuk}</td>${_sinav.sira_no ? `<td style="text-align:center;color:${s.komsuAyni ? "#e65100" : "#34a853"};">${s.komsuAyni}</td>` : ""}</tr>`).join("")}
    </tbody></table></div>`;
  el.innerHTML = html;
}

window.kelebekDagitYap = () => {
  const ogr = _secilenOgrenciler();
  const salonlar = _gecerliSalonlar();
  if (!ogr.length) { mesajGoster("kbMesaj", "Sınava girecek şubeleri seçin.", "hata"); return; }
  if (salonlar.length !== _sinav.salonlar.length) { mesajGoster("kbMesaj", "Her salon için bir sınıf seçin ya da Diğer salona ad yazın.", "hata"); return; }
  if (new Set(salonlar.map((s) => s.ad)).size !== salonlar.length) { mesajGoster("kbMesaj", "Aynı salon iki kez eklenmiş.", "hata"); return; }
  try {
    _sinav.dagilim = kelebekDagit(ogr, salonlar, !!_sinav.sira_no, Date.now());
    _dagilimEski = false;
    _dagitimCiz(); _ciktiCiz(); _gozetmenYukle();
  } catch (err) {
    mesajGoster("kbMesaj", err.message, "hata");
  }
};

window.kelebekKaydet = async () => {
  const ad = (_sinav.ad || "").trim();
  if (!ad || !_sinav.tarih) { mesajGoster("kbMesaj", "Sınav adı ve tarihi girin.", "hata"); return; }
  if (!_sinav.saatler.length) { mesajGoster("kbMesaj", "En az bir ders saati seçin.", "hata"); return; }
  if (_dagilimEski) { mesajGoster("kbMesaj", "Değişikliklerden sonra yeniden dağıtın, sonra kaydedin.", "hata"); return; }
  const veri = {
    ad, tarih: _sinav.tarih, saatler: _sinav.saatler, sira_no: !!_sinav.sira_no,
    siniflar: _sinav.siniflar, haric: _sinav.haric,
    salonlar: _sinav.salonlar.map((s) => ({ ad: _salonAd(s), sinif: s.sinif || "", kapasite: Number(s.kapasite) || 0 })),
    dagilim: _sinav.dagilim, gozetmenler: _sinav.gozetmenler || {},
    olusturan_ad: state.kullanici?.ad || "", guncelleme: serverTimestamp(),
  };
  try {
    if (_sinav.id) await setDoc(doc(db, "kelebek_sinavlar", _sinav.id), veri, { merge: true });
    else {
      const ref = await addDoc(collection(db, "kelebek_sinavlar"), { ...veri, olusturma: serverTimestamp() });
      _sinav.id = ref.id;
    }
    mesajGoster("kbMesaj", "Kaydedildi.", "basari");
  } catch (err) {
    mesajGoster("kbMesaj", "Kaydedilemedi: " + err.message, "hata");
  }
};

// ── Gözetmenler ──
// Otomatik: o tarih+saat+salon sinifinda dersi olan ogretmen (today_lessons;
// vekil varsa vekil), today_lessons yoksa haftalik program. Raporlu isaretlenir.
async function _gozetmenYukle() {
  const el = document.getElementById("kbGozetmen");
  if (!el) return;
  const salonlar = _gecerliSalonlar();
  if (!_sinav.tarih || !_sinav.saatler.length || !salonlar.length) {
    el.innerHTML = '<div class="bos-mesaj">Tarih, ders saati ve salon seçilince gözetmenler gösterilir.</div>';
    _gozetmen = {};
    return;
  }
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const tarih = _sinav.tarih;
  try {
    const [gunlukSnap, raporSnap] = await Promise.all([
      getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih))),
      getDocs(query(collection(db, "ogretmen_rapor"), where("baslangic_tarihi", "<=", tarih))),
    ]);
    let dersler = gunlukSnap.docs.map((d) => d.data());
    let kaynak = "günlük ders tablosu";
    if (!dersler.length) {
      if (!_program) _program = (await getDocs(collection(db, "schedule"))).docs.map((d) => d.data());
      const gun = GUNLER[new Date(tarih + "T12:00:00").getDay()];
      dersler = _program.filter((d) => normalizeGun(d.day) === gun);
      kaynak = "haftalık ders programı";
    }
    const raporlu = new Set();
    raporSnap.forEach((d) => { const r = d.data(); if (r.bitis_tarihi >= tarih) raporlu.add(r.ogretmen_id); });
    if (_sinav.tarih !== tarih) return;
    _gozetmen = {};
    salonlar.forEach((s) => _sinav.saatler.forEach((saat) => {
      const anahtar = s.ad + "|" + saat;
      const ders = s.sinif ? dersler.find((d) => d.class_id === s.sinif && Number(d.lesson_number) === saat) : null;
      const otoId = ders ? (ders.substitute_teacher_id || ders.teacher_id || "") : "";
      const elle = (_sinav.gozetmenler || {})[anahtar];
      if (elle) {
        _gozetmen[anahtar] = { id: elle.ogretmen_id, ad: elle.ad, raporlu: raporlu.has(elle.ogretmen_id), kaynak: "elle",
          asil_id: otoId, asil_ad: ogretmenAd(otoId) };
      } else {
        _gozetmen[anahtar] = { id: otoId, ad: ogretmenAd(otoId), raporlu: !!otoId && raporlu.has(otoId), kaynak: "program" };
      }
    }));
    _gozetmenCiz(salonlar, kaynak);
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Gözetmenler yüklenemedi: ${esc(err.message)}</div>`;
  }
}

function _gozetmenCiz(salonlar, kaynak) {
  const el = document.getElementById("kbGozetmen");
  const ro = !admin();
  el.innerHTML = `<p style="font-size:13px;color:var(--text2);margin-bottom:8px;">Her ders saatinde o salonda (sınıfta) dersi olan öğretmen gözetmendir; öğretmen kendi dersinin başladığı saatte gelir. Kaynak: ${esc(kaynak)}. Okulda olmayan gözetmenin yerine "Değiştir" ile önce boş nöbetçi, yoksa diğer boş öğretmenlerden birini seçin.</p>
    <div style="overflow-x:auto;"><table><thead><tr><th>Salon</th>${_sinav.saatler.map((s) => `<th>${s}. ders</th>`).join("")}</tr></thead><tbody>
    ${salonlar.map((s) => `<tr><td><strong>${esc(s.ad)}</strong></td>${_sinav.saatler.map((saat) => {
      const g = _gozetmen[s.ad + "|" + saat] || {};
      const anahtar = esc(s.ad + "|" + saat);
      let ic = g.id ? `<strong>${esc(g.ad)}</strong>` : '<span style="color:#ea4335;">Gözetmen yok</span>';
      if (g.raporlu) ic += ' <span class="rozet" style="background:#fce8e6;color:#c5221f;font-size:11px;">⚠ Raporlu</span>';
      if (g.kaynak === "elle") ic += `<div style="font-size:11px;color:var(--text2);">elle atandı${g.asil_ad ? ` (${esc(g.asil_ad)} yerine)` : ""}</div>`;
      const btn = ro ? "" : `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
        <button class="btn btn-gri btn-sm" data-k="${anahtar}" onclick="kelebekGozetmenDegistir(this.dataset.k, this)">Değiştir</button>
        ${g.kaynak === "elle" ? `<button class="btn btn-gri btn-sm" data-k="${anahtar}" onclick="kelebekGozetmenOtomatik(this.dataset.k)">Otomatiğe dön</button>` : ""}</div>
        <div class="kb-aday" data-k="${anahtar}"></div>`;
      return `<td style="vertical-align:top;min-width:150px;">${ic}${btn}</td>`;
    }).join("")}</tr>`).join("")}
    </tbody></table></div>
    ${ro ? "" : '<p style="font-size:12px;color:var(--text2);margin-top:6px;">Gözetmen değişiklikleri "Kaydet" ile saklanır.</p>'}`;
}

window.kelebekGozetmenDegistir = async (anahtar, btn) => {
  const kutu = [...document.querySelectorAll("#kbGozetmen .kb-aday")].find((e) => e.dataset.k === anahtar);
  if (!kutu) return;
  const saat = Number(anahtar.split("|").pop());
  const haric = Object.entries(_gozetmen).filter(([k, g]) => k !== anahtar && k.endsWith("|" + saat) && g.id).map(([, g]) => g.id);
  btn.disabled = true;
  kutu.innerHTML = '<div style="font-size:12px;">Yükleniyor...</div>';
  try {
    const { data } = await httpsCallable(functions, "kelebekGozetmenAdaylari")({ tarih: _sinav.tarih, saat, haric });
    if (data.sebep) { kutu.innerHTML = `<div style="font-size:12px;color:#ea4335;">${esc(data.sebep)}</div>`; return; }
    const secenek = (o) => `<option value="${esc(o.id)}">${esc(o.ad)}</option>`;
    kutu.innerHTML = `<select style="margin-top:4px;max-width:220px;" data-k="${esc(anahtar)}" onchange="kelebekGozetmenSec(this.dataset.k, this)">
      <option value="">Öğretmen seçin...</option>
      ${data.nobetci.length ? `<optgroup label="🛡 Nöbetçi (o saatte boş)">${data.nobetci.map(secenek).join("")}</optgroup>` : ""}
      ${data.diger.length ? `<optgroup label="Diğer boş öğretmenler">${data.diger.map(secenek).join("")}</optgroup>` : ""}
    </select>
    ${data.nobetBilinmiyor ? '<div style="font-size:11px;color:var(--text2);">Bu tarih için nöbetçi bilgisi yok (nöbet çizelgesi sadece içinde bulunulan hafta için hesaplanır).</div>' : ""}
    ${!data.nobetci.length && !data.diger.length ? '<div style="font-size:12px;color:#ea4335;">O saatte boş öğretmen yok.</div>' : ""}`;
  } catch (err) {
    kutu.innerHTML = `<div style="font-size:12px;color:#ea4335;">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
};

window.kelebekGozetmenSec = (anahtar, sel) => {
  if (!sel.value) return;
  _sinav.gozetmenler = { ...(_sinav.gozetmenler || {}), [anahtar]: { ogretmen_id: sel.value, ad: sel.options[sel.selectedIndex].text } };
  _gozetmenYukle();
};
window.kelebekGozetmenOtomatik = (anahtar) => {
  const g = { ...(_sinav.gozetmenler || {}) };
  delete g[anahtar];
  _sinav.gozetmenler = g;
  _gozetmenYukle();
};

// ── Çıktılar ──
function _ciktiCiz() {
  const el = document.getElementById("kbCikti");
  if (!el) return;
  if (!_sinav.dagilim.length || _dagilimEski) { el.innerHTML = '<div class="bos-mesaj">Önce dağıtım yapın.</div>'; return; }
  el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-mavi" onclick="kelebekYazdir('salon')">🖨 Salon kapı listeleri</button>
    <button class="btn btn-mavi" onclick="kelebekYazdir('sube')">🖨 Şube listeleri</button>
    <button class="btn btn-yesil" id="kbExcelBtn" onclick="kelebekExcel()">📊 Excel</button></div>`;
}

function _salonSirasi() {
  const sira = _gecerliSalonlar().map((s) => s.ad);
  [...new Set(_sinav.dagilim.map((d) => d.salon))].forEach((s) => { if (!sira.includes(s)) sira.push(s); });
  return sira;
}
const _siraliSalon = (salon) => _sinav.dagilim.filter((d) => d.salon === salon)
  .sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.ad.localeCompare(b.ad, "tr"));
const _gozetmenMetni = (salon) => _sinav.saatler.map((saat) => {
  const g = _gozetmen[salon + "|" + saat];
  return `${saat}. ders: ${g && g.id ? g.ad : "—"}`;
});

function _baslikHtml(altBaslik) {
  return `<div class="kb-baslik"><div>${esc(_okulAd)}</div><div>${esc(_sinav.ad)}</div>
    <div style="font-weight:400;">${esc(trTarih(_sinav.tarih))} · ${esc(saatMetni(_sinav.saatler))}</div>
    <div class="kb-alt">${esc(altBaslik)}</div></div>`;
}

window.kelebekYazdir = (tur) => {
  const siraVar = !!_sinav.sira_no;
  let html = "";
  if (tur === "salon") {
    html = _salonSirasi().map((salon) => {
      const liste = _siraliSalon(salon);
      return `<div class="kb-sayfa">${_baslikHtml("Salon: " + salon + " (" + liste.length + " öğrenci)")}
        <div class="kb-gozetmen">Gözetmenler: ${_gozetmenMetni(salon).map(esc).join(" · ")}</div>
        <table class="kb-tablo"><thead><tr>${siraVar ? "<th>Sıra</th>" : "<th>#</th>"}<th>No</th><th>Ad Soyad</th><th>Şube</th></tr></thead><tbody>
        ${liste.map((d, i) => `<tr><td>${siraVar ? d.sira : i + 1}</td><td>${esc(d.no)}</td><td class="kb-sol">${esc(d.ad)}</td><td>${esc(d.sinif)}</td></tr>`).join("")}
        </tbody></table></div>`;
    }).join("");
  } else {
    const subeler = [...new Set(_sinav.dagilim.map((d) => d.sinif))].sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
    html = subeler.map((sube) => {
      const liste = _sinav.dagilim.filter((d) => d.sinif === sube)
        .sort((a, b) => a.no.localeCompare(b.no, "tr", { numeric: true }));
      return `<div class="kb-sayfa">${_baslikHtml("Şube: " + sube + " (" + liste.length + " öğrenci)")}
        <table class="kb-tablo"><thead><tr><th>No</th><th>Ad Soyad</th><th>Salon</th>${siraVar ? "<th>Sıra</th>" : ""}</tr></thead><tbody>
        ${liste.map((d) => `<tr><td>${esc(d.no)}</td><td class="kb-sol">${esc(d.ad)}</td><td>${esc(d.salon)}</td>${siraVar ? `<td>${d.sira}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>`;
    }).join("");
  }
  document.getElementById("kelebekYazdirAlan").innerHTML = html;
  document.body.classList.add("kelebek-yazdir");
  const bitir = () => { document.body.classList.remove("kelebek-yazdir"); window.removeEventListener("afterprint", bitir); };
  window.addEventListener("afterprint", bitir);
  window.print();
};

window.kelebekExcel = async () => {
  const btn = document.getElementById("kbExcelBtn");
  btn.disabled = true;
  try {
    const XLSX = await xlsxYukle();
    const wb = XLSX.utils.book_new();
    const kullanilan = new Set();
    const sayfaAdi = (ad) => {
      let s = String(ad).replace(/[\\/?*[\]:]/g, "-").slice(0, 28) || "Salon";
      let t = s, i = 2;
      while (kullanilan.has(t.toLocaleLowerCase("tr"))) t = `${s} ${i++}`;
      kullanilan.add(t.toLocaleLowerCase("tr"));
      return t;
    };
    const siraVar = !!_sinav.sira_no;
    const baslik = [[_okulAd], [_sinav.ad], [`${trTarih(_sinav.tarih)} · ${saatMetni(_sinav.saatler)}`], []];

    const tum = [...baslik, ["Salon", "Sıra", "No", "Ad Soyad", "Şube"]];
    _salonSirasi().forEach((salon) => _siraliSalon(salon).forEach((d, i) => tum.push([salon, siraVar ? d.sira : i + 1, d.no, d.ad, d.sinif])));
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, tum, [20, 6, 8, 28, 8]), sayfaAdi("Tüm Liste"));

    _salonSirasi().forEach((salon) => {
      const s = [...baslik, [`Salon: ${salon}`], ..._gozetmenMetni(salon).map((g) => ["Gözetmen", g]), [],
        [siraVar ? "Sıra" : "#", "No", "Ad Soyad", "Şube"],
        ..._siraliSalon(salon).map((d, i) => [siraVar ? d.sira : i + 1, d.no, d.ad, d.sinif])];
      XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s, [10, 26, 28, 8]), sayfaAdi(salon));
    });

    const sube = [...baslik, ["Şube", "No", "Ad Soyad", "Salon", "Sıra"],
      ..._sinav.dagilim.slice().sort((a, b) => a.sinif.localeCompare(b.sinif, "tr", { numeric: true }) || a.no.localeCompare(b.no, "tr", { numeric: true }))
        .map((d) => [d.sinif, d.no, d.ad, d.salon, siraVar ? d.sira : ""])];
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, sube, [8, 8, 28, 20, 6]), sayfaAdi("Şubeler"));

    const goz = [...baslik, ["Salon", "Ders Saati", "Gözetmen", "Kaynak", "Not"]];
    _salonSirasi().forEach((salon) => _sinav.saatler.forEach((saat) => {
      const g = _gozetmen[salon + "|" + saat] || {};
      goz.push([salon, `${saat}. ders`, g.id ? g.ad : "—", g.kaynak === "elle" ? "Elle" : "Programdan",
        [g.raporlu ? "Raporlu" : "", g.kaynak === "elle" && g.asil_ad ? g.asil_ad + " yerine" : ""].filter(Boolean).join(", ")]);
    }));
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, goz, [20, 10, 26, 12, 24]), sayfaAdi("Gözetmenler"));

    XLSX.writeFile(wb, dosyaAdi(`Kelebek ${_sinav.ad} ${trTarih(_sinav.tarih)}`) + ".xlsx");
  } catch (err) {
    mesajGoster("kbMesaj", err.message, "hata");
  }
  btn.disabled = false;
};
