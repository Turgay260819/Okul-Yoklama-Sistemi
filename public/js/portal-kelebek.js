import {
  db, functions, httpsCallable, bugunHesapla,
  getDocs, getDoc, addDoc, setDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";
import { xlsxYukle, sayfaOlustur, dosyaAdi } from "./portal-excel.js";
import { kelebekDagit, kelebekIstatistik, kademeAl, salonOner, sonrakiSira } from "./kelebek-dagit.js";
import {
  DIGER, trTarih, saatMetni, salonSirasi, siraliSalon, programDersleri, otoGozetmen, gozetmenTablosu, gecmisGozetmenKaydi,
  yoklamaOku, yoklamaId, yoklamaDurumHtml, yoklamaFormuCiz, yokMetni,
} from "./kelebek-ortak.js";

// ── KELEBEK SINAV ──
// Admin sinav olusturur: sube secimi, salonlar (mevcut siniflar ya da elle),
// kelebek dagitimi (kelebek-dagit.js), istege bagli sira no. Gozetmenler her
// acilista programdan hesaplanir (o tarih+saat+salon sinifinda dersi olan;
// vekil varsa vekil); kaydedilen sadece adminin elle yaptigi degisiklikler
// (gozetmenler["salon|saat"]). Idare goruntuler; sadece admin duzenler.


let _ogrenciler = null;   // tum aktif ogrenciler (ilk acilista)
let _okulAd = "AHMET YENİCE ORTAOKULU MÜDÜRLÜĞÜ";
let _sinav = null;        // duzenlenen sinav
let _gozetmen = {};       // "salon|saat" -> { id, ad, raporlu, kaynak, asil_id, asil_ad }
let _secili = new Set();  // sinava girecek ogrenci_id'ler
let _acikSubeler = new Set(); // acik akordiyonlar (yeniden cizimde korunur)
let _sinavListesi = [];   // son okunan sinav listesi (yeni sinavda onceki secim icin)
let _silinenleriGoster = false;

// Ana liste (kelebek_ayarlar/ana_liste): sinava girecek ogrencilerin guncel
// listesi. Yeni sinav secimini buradan alir; var olan sinavlar degismez.
let _anaSecili = new Set();
let _anaAcik = new Set();     // ana listede acik sube akordiyonlari
let _anaKartAcik = false;
let _anaVar = false;          // belge Firestore'da var mi
let _anaBilgi = {};           // { guncelleme, guncelleyen_ad }
let _anaSon = new Set();      // son kaydedilen secim
let _anaDamga = null;         // belgede son gorulen guncelleme (ms)
let _anaZamanlayici = null;
let _anaKayitSirasi = Promise.resolve();
let _anaCakisma = false;
let _anaDurum = { tur: "" };
const ANA_REF = () => doc(db, "kelebek_ayarlar", "ana_liste");
const _anaKirli = () => _anaSecili.size !== _anaSon.size || [..._anaSecili].some((id) => !_anaSon.has(id));

const admin = () => state.rol === "admin";
// Arsive tasinmis (silinmis) sinav sadece goruntulenir.
const duzenler = () => admin() && !_sinav?.silindi;
const _ms = (z) => z?.toMillis?.() ?? 0;
const kok = () => document.getElementById("sayfa-kelebek");
const ogretmenAd = (id) => state.ogretmenler.find((o) => o.id === id)?.ad || "";

export async function kelebekYukle() {
  // Acik sinavda bekleyen kayit once yazilir; yazilamadiysa duzenleyici
  // kapatilmaz (girilen veri kaybolmasin).
  if (_sinav) {
    await _bekleyenKaydiYaz();
    if (_kirli()) { _duzenleyiciCiz(); mesajGoster("kbMesaj", "Kaydedilmemiş değişiklikler var; sınav açık bırakıldı.", "hata"); return; }
  }
  kok().innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    // Ogrenciler her giriste yeniden okunur: Ayarlar'dan sonradan eklenen
    // ogrenciler portal yenilenmeden de listede gorunsun.
    const ilk = !_ogrenciler;
    await _ogrencileriOku();
    if (ilk) {
      try {
        const y = await getDoc(doc(db, "nobet2_ayarlar", "yazi"));
        if (y.exists() && y.data().okul) _okulAd = y.data().okul;
      } catch (e) { /* varsayilan */ }
    }
    _sinav = null;
    if (admin()) { await _anaBekleyenYaz(); await _anaOku(); }
    await _listeCiz();
  } catch (err) {
    kok().innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.kelebekYukle = kelebekYukle;

async function _ogrencileriOku() {
  const snap = await getDocs(query(collection(db, "students"), where("status", "==", "active")));
  _ogrenciler = snap.docs.map((d) => {
    const o = d.data();
    return { ogrenci_id: d.id, no: String(o.student_number || ""), ad: o.name || "", sinif: o.class_id || "" };
  }).filter((o) => o.sinif);
}

// Sinav acikken baska sekmede ogrenci eklendiyse: secim korunur, yeni
// ogrenciler isaretsiz gelir, artik bulunmayan secili ogrenciler secimden duser
// (dagitimda olanlar haric: sinav kaydi bozulmasin).
window.kelebekOgrencileriYenile = async (btn) => {
  if (btn) btn.disabled = true;
  try {
    const onceki = _ogrenciler.length;
    await _ogrencileriOku();
    const mevcut = new Set(_ogrenciler.map((o) => o.ogrenci_id));
    const dagitimda = new Set(_sinav.dagilim.map((x) => x.ogrenci_id));
    const dusen = [..._secili].filter((id) => !mevcut.has(id) && !dagitimda.has(id));
    dusen.forEach((id) => _secili.delete(id));
    _ogrencilerCiz(); _salonlarCiz();
    if (dusen.length) { _dagilimDegisti(); _otoKaydet(); }
    const fark = _ogrenciler.length - onceki;
    mesajGoster("kbMesaj", `Öğrenci listesi yenilendi${fark > 0 ? `: ${fark} yeni öğrenci` : ""}.${dusen.length ? ` ${dusen.length} öğrenci artık kayıtlı değil, seçimden çıkarıldı.` : ""}`, "basari");
  } catch (err) {
    mesajGoster("kbMesaj", "Yenilenemedi: " + err.message, "hata");
  }
  if (btn) btn.disabled = false;
};

// ═══════════ SINAV LİSTESİ ═══════════
async function _listeCiz() {
  const snap = await getDocs(collection(db, "kelebek_sinavlar"));
  _sinavListesi = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.tarih || "").localeCompare(a.tarih || ""));
  const silinenSayi = _sinavListesi.filter((s) => s.silindi).length;
  const liste = _sinavListesi.filter((s) => _silinenleriGoster || !s.silindi);
  const kisa = (z) => z?.toDate ? z.toDate().toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  if (admin() && !_anaVar && !_anaTohum) {
    // Ilk kullanim: ana liste en son olusturulan sinavin seciminden baslar
    // (sadece ekranda; ilk degisiklikte kaydedilir).
    _anaTohum = true;
    const son = _sonSinav();
    const aktif = new Set(_ogrenciler.map((o) => o.ogrenci_id));
    _anaSecili = son ? new Set([..._secimCikar(son)].filter((id) => aktif.has(id))) : new Set();
    _anaSon = new Set(_anaSecili);
    _anaKaynak = son ? `«${son.ad}» (${trTarih(son.tarih)})` : "";
  }
  kok().innerHTML = `${admin() ? '<div class="kart" id="kbAnaKart"></div>' : ""}<div class="kart">
    <div class="kart-baslik-satir"><div class="kart-baslik">🦋 Kelebek Sınavlar</div>
      ${admin() ? '<button class="btn btn-yesil btn-sm" onclick="kelebekYeni()">➕ Yeni Sınav</button>' : ""}</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Öğrenciler salonlara aynı şubeden olanlar mümkün olduğunca bir arada olmayacak şekilde dağıtılır. Gözetmenler, sınav saatlerinde o salonda (sınıfta) dersi olan öğretmenlerdir.</p>
    ${silinenSayi ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:8px;">
      <input type="checkbox" ${_silinenleriGoster ? "checked" : ""} onchange="kelebekSilinenler(this.checked)"> 🗄 Silinen (arşivdeki) sınavları göster (${silinenSayi})</label>` : ""}
    ${liste.length ? `<div style="overflow-x:auto;"><table><thead><tr><th>Tarih</th><th>Sınav</th><th>Saat</th><th>Öğrenci</th><th>Salon</th><th>Son değişiklik</th><th></th></tr></thead><tbody>
      ${liste.map((s) => `<tr${s.silindi ? ' style="opacity:.6;"' : ""}><td style="white-space:nowrap;">${esc(trTarih(s.tarih))}</td><td><strong>${esc(s.ad)}</strong>${s.sira_no ? ' <span class="rozet rozet-mavi" style="font-size:11px;">sıra no</span>' : ""}
          ${s.silindi ? `<div style="font-size:11px;color:#c5221f;">🗄 Silindi ${esc(kisa(s.silme))}${s.silen_ad ? " · " + esc(s.silen_ad) : ""}</div>` : ""}</td>
        <td style="white-space:nowrap;">${esc(saatMetni(s.saatler))}</td><td>${(s.dagilim || []).length}</td><td>${(s.salonlar || []).length}</td>
        <td style="font-size:12px;white-space:nowrap;">${esc(kisa(s.guncelleme))}${s.guncelleyen_ad ? " · " + esc(s.guncelleyen_ad) : ""}</td>
        <td style="white-space:nowrap;"><button class="btn btn-mavi btn-sm" data-id="${esc(s.id)}" onclick="kelebekAc(this.dataset.id)">Aç</button>
        ${!admin() ? "" : s.silindi
          ? `<button class="btn btn-yesil btn-sm" data-id="${esc(s.id)}" onclick="kelebekGeriAl(this.dataset.id)">Geri al</button>`
          : `<button class="btn btn-kirmizi btn-sm" data-id="${esc(s.id)}" onclick="kelebekSil(this.dataset.id)">Sil</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : '<div class="bos-mesaj">Henüz kelebek sınav yok.</div>'}
    <div class="mesaj" id="kbListeMesaj"></div>
  </div>`;
  _anaKartCiz();
}

function _sonSinav() {
  return _sinavListesi.filter((s) => !s.silindi)
    .sort((a, b) => _ms(b.olusturma) - _ms(a.olusturma) || (b.tarih || "").localeCompare(a.tarih || ""))[0];
}

window.kelebekSilinenler = (acik) => { _silinenleriGoster = acik; _listeCiz(); };

// ═══════════ ANA LİSTE (Sınava Girecek Öğrenciler) ═══════════
// Sadece admin. Degisiklikler 1,5 sn sonra kendiliginden yazilir; her kayit
// kelebek_ayarlar/ana_liste/gecmis'e degistirilemez satir olarak eklenir.
let _anaTohum = false;  // belge yokken son sinavdan baslangic yapildi
let _anaKaynak = "";    // baslangic yapilan sinavin adi
let _anaGecmisAcik = false;

async function _anaOku() {
  const d = await getDoc(ANA_REF());
  _anaVar = d.exists();
  _anaCakisma = false;
  _anaDurum = { tur: "" };
  if (!_anaVar) { _anaTohum = false; _anaDamga = null; _anaBilgi = {}; return; }
  _anaBilgi = d.data();
  _anaDamga = _ms(_anaBilgi.guncelleme) || null;
  // Artik kayitli olmayan (mezun/silinmis) ogrenciler listeden duser.
  const aktif = new Set(_ogrenciler.map((o) => o.ogrenci_id));
  _anaSecili = new Set((_anaBilgi.ogrenciler || []).filter((id) => aktif.has(id)));
  _anaSon = new Set(_anaSecili);
}

function _anaKartCiz() {
  const el = document.getElementById("kbAnaKart");
  if (!el) return;
  el.innerHTML = `<div class="kart-baslik-satir" style="cursor:pointer;" onclick="kelebekAnaKart()">
      <div class="kart-baslik">👥 Sınava Girecek Öğrenciler <span id="kbAnaOzet" style="font-size:13px;font-weight:400;color:var(--text2);"></span></div>
      <span>${_anaKartAcik ? "▲" : "▼"}</span></div>
    <div ${_anaKartAcik ? "" : "hidden"}>
      <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Sınavlara girecek öğrencilerin güncel listesi. Yeni sınavın öğrenci seçimi bu listeden gelir: sınava girmekten vazgeçenleri buradan çıkarın, yeni katılanları ekleyin. Var olan sınavlar değişmez (istenirse sınavın içinde "Ana listeyi uygula").</p>
      ${!_anaVar && _anaKaynak ? `<div class="uyari-kutu-sm">Liste henüz kaydedilmedi; başlangıç olarak ${esc(_anaKaynak)} sınavının seçimi gösteriliyor. İlk değişiklikte kaydedilir.</div>` : ""}
      <div id="kbAnaListe"></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px;">
        <span id="kbAnaDurum" style="font-size:13px;"></span>
        <button class="btn btn-gri btn-sm" onclick="kelebekAnaGecmis()">🕘 ${_anaGecmisAcik ? "Geçmişi gizle" : "Değişiklik geçmişi"}</button></div>
      <div id="kbAnaGecmis"></div>
    </div>`;
  if (_anaKartAcik) _ogrencilerCiz("ana");
  if (_anaGecmisAcik) _anaGecmisYukle();
  _anaOzetCiz();
  _anaDurumCiz();
}

window.kelebekAnaKart = () => { _anaKartAcik = !_anaKartAcik; _anaKartCiz(); };
window.kelebekAnaGecmis = () => { _anaGecmisAcik = !_anaGecmisAcik; _anaKartCiz(); };

function _anaOzetCiz() {
  const el = document.getElementById("kbAnaOzet");
  if (!el) return;
  const secilen = _ogrenciler.filter((o) => _anaSecili.has(o.ogrenci_id));
  const z = _anaBilgi.guncelleme?.toDate?.();
  el.textContent = `— ${secilen.length} öğrenci, ${new Set(secilen.map((o) => o.sinif)).size} şube` +
    (z ? ` · son değişiklik ${z.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}${_anaBilgi.guncelleyen_ad ? " · " + _anaBilgi.guncelleyen_ad : ""}` : "");
}

function _anaDurumYaz(tur, metin = "") { _anaDurum = { tur, metin, zaman: new Date() }; _anaDurumCiz(); }

function _anaDurumCiz() {
  const el = document.getElementById("kbAnaDurum");
  if (!el) return;
  const d = _anaDurum;
  const saat = d.zaman ? d.zaman.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
  const g = {
    bekliyor: ["var(--text2)", "● Kaydedilecek…"],
    kaydediliyor: ["var(--text2)", "Kaydediliyor…"],
    kaydedildi: ["#34a853", `✓ Kaydedildi ${saat}`],
    hata: ["#ea4335", `⚠ Kaydedilemedi: ${d.metin}`],
  }[d.tur];
  el.style.color = g ? g[0] : "var(--text2)";
  el.textContent = g ? g[1] : (_anaVar ? "Değişiklikler otomatik kaydedilir" : "");
}

function _anaDegisti() {
  _secimGostergeleri("ana");
  _anaOzetCiz();
  clearTimeout(_anaZamanlayici);
  _anaZamanlayici = null;
  if (_anaCakisma) { _anaDurumYaz("hata", "liste başka yerde değiştirildi; sayfayı yenileyin"); return; }
  _anaDurumYaz("bekliyor");
  _anaZamanlayici = setTimeout(() => { _anaZamanlayici = null; _anaKaydet().catch(() => {}); }, 1500);
}

async function _anaBekleyenYaz() {
  if (_anaZamanlayici) { clearTimeout(_anaZamanlayici); _anaZamanlayici = null; await _anaKaydet().catch(() => {}); }
  await _anaKayitSirasi;
}

function _anaKaydet() {
  const is = _anaKayitSirasi.then(_anaKaydetIc);
  _anaKayitSirasi = is.catch(() => {});
  return is;
}

async function _anaKaydetIc() {
  if (_anaCakisma) throw new Error("Ana liste başka bir yerde değiştirildi; sayfayı yenileyin.");
  const secim = new Set(_anaSecili);
  const onceki = _anaSon;
  const eklenen = [...secim].filter((id) => !onceki.has(id));
  const cikan = [...onceki].filter((id) => !secim.has(id));
  if (_anaVar && !eklenen.length && !cikan.length) { _anaDurumYaz("kaydedildi"); return; }
  _anaDurumYaz("kaydediliyor");
  try {
    const kim = state.kullanici?.ad || "";
    const mevcut = await getDoc(ANA_REF());
    const damga = mevcut.exists() ? (_ms(mevcut.data().guncelleme) || null) : null;
    if (damga !== _anaDamga) {
      _anaCakisma = true;
      throw new Error("Ana liste başka bir yerde (başka sekme ya da kişi) değiştirildi; üzerine yazılmaması için kaydedilmedi. Sayfayı yenileyin.");
    }
    await setDoc(ANA_REF(), { ogrenciler: [...secim], guncelleme: serverTimestamp(), guncelleyen_ad: kim });
    _anaBilgi = (await getDoc(ANA_REF())).data() || {};
    _anaDamga = _ms(_anaBilgi.guncelleme) || null;
    const ilk = !_anaVar;
    _anaVar = true;
    _anaSon = secim;
    const ad = (id) => _ogrenciler.find((o) => o.ogrenci_id === id)?.ad || "?";
    const adlar = (ids) => ids.slice(0, 10).map(ad).join(", ") + (ids.length > 10 ? ` +${ids.length - 10}` : "");
    await addDoc(collection(db, "kelebek_ayarlar", "ana_liste", "gecmis"), {
      zaman: serverTimestamp(), yapan_ad: kim, ogrenci_sayisi: secim.size,
      detay: (ilk ? `Liste oluşturuldu: ${secim.size} öğrenci${_anaKaynak ? " (başlangıç: " + _anaKaynak + ")" : ""}` : `${onceki.size} → ${secim.size} öğrenci`) +
        (!ilk && eklenen.length ? `; eklenen ${eklenen.length}: ${adlar(eklenen)}` : "") +
        (!ilk && cikan.length ? `; çıkarılan ${cikan.length}: ${adlar(cikan)}` : ""),
    });
    _anaDurumYaz(_anaZamanlayici ? "bekliyor" : "kaydedildi");
    _anaOzetCiz();
    if (_anaGecmisAcik) _anaGecmisYukle();
    if (ilk) _anaKartCiz();  // "henuz kaydedilmedi" notu kalksin
  } catch (err) {
    _anaDurumYaz("hata", err.message);
    throw err;
  }
}

async function _anaGecmisYukle() {
  const el = document.getElementById("kbAnaGecmis");
  if (!el) return;
  try {
    const snap = await getDocs(collection(db, "kelebek_ayarlar", "ana_liste", "gecmis"));
    const g = snap.docs.map((d) => d.data()).sort((a, b) => (b.zaman?.toMillis?.() ?? Infinity) - (a.zaman?.toMillis?.() ?? Infinity));
    el.innerHTML = g.length ? `<div style="overflow-x:auto;margin-top:8px;"><table><thead><tr><th>Ne zaman</th><th>Kim</th><th>Ayrıntı</th></tr></thead><tbody>
      ${g.map((x) => `<tr><td style="white-space:nowrap;font-size:12px;">${esc(_zamanMetni(x.zaman))}</td><td style="font-size:12px;">${esc(x.yapan_ad)}</td><td style="font-size:12px;">${esc(x.detay)}</td></tr>`).join("")}
      </tbody></table></div>` : '<div class="bos-mesaj">Henüz kayıtlı değişiklik yok.</div>';
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Geçmiş okunamadı: ${esc(err.message)}</div>`;
  }
}

// Secim ogrenci bazinda (ogrenciler). Eski kayitlarda sube + haric vardi.
function _secimCikar(v) {
  if (Array.isArray(v.ogrenciler)) return new Set(v.ogrenciler);
  const subeler = new Set(v.siniflar || []);
  const haric = new Set(v.haric || []);
  return new Set(_ogrenciler.filter((o) => subeler.has(o.sinif) && !haric.has(o.ogrenci_id)).map((o) => o.ogrenci_id));
}

function _duzenleyiciSifirla() {
  _acikSubeler = new Set();
  _acikSalon = null;
  _gecmis = [];
  _gozetmenCanli = false;
  _bilgiAcik = new Set();
  _bilgiArama = "";
  _degisiklik = _kaydedilen = 0;
  _cakisma = false;
  _kayitDurum = { tur: "" };
  _yoklama = null;
  _yoklamaForm = null;
}

// Yeni sinavin ogrenci secimi ana listeden gelir (ekrandaki son hali). Ana
// liste hic kaydedilmediyse en son olusturulan (silinmemis) sinavdan.
window.kelebekYeni = async () => {
  await _anaBekleyenYaz();
  _sinav = { id: null, ad: "", tarih: bugunHesapla(), saatler: [], sira_no: false,
    salonlar: [{ ad: "", sinif: "", kapasite: 0 }], dagilim: [], gozetmenler: {} };
  const onceki = _sonSinav();
  const aktif = new Set(_ogrenciler.map((o) => o.ogrenci_id));
  const kaynak = _anaVar ? _anaSecili : (onceki ? _secimCikar(onceki) : new Set());
  _secili = new Set([...kaynak].filter((id) => aktif.has(id)));
  _duzenleyiciSifirla();
  _sonKayit = null;
  _surumDamga = null;
  _duzenleyiciCiz();
  if (_anaVar) mesajGoster("kbMesaj", `Öğrenci seçimi güncel ana listeden (Sınava Girecek Öğrenciler) getirildi: ${_secili.size} öğrenci. Bu sınav için değiştirebilirsiniz; ana liste değişmez.`, "bilgi");
  else if (_secili.size) mesajGoster("kbMesaj", `Öğrenci seçimi «${onceki.ad}» (${trTarih(onceki.tarih)}) sınavından getirildi: ${_secili.size} öğrenci. İstediğiniz gibi değiştirebilirsiniz.`, "bilgi");
};

window.kelebekAc = async (id) => {
  await _anaBekleyenYaz();
  const d = await getDoc(doc(db, "kelebek_sinavlar", id));
  if (!d.exists()) return;
  _sinav = { id, gozetmenler: {}, dagilim: [], saatler: [], salonlar: [], ...d.data() };
  _secili = _secimCikar(_sinav);
  _duzenleyiciSifirla();
  _sonKayit = _durumOzeti();
  _surumDamga = _ms(_sinav.guncelleme) || null;
  _duzenleyiciCiz();
};

// Silme kalici degildir: sinav arsive tasinir (silindi), tum verisi ve
// gecmisi saklanir, "Geri al" ile donulur.
window.kelebekSil = async (id) => {
  if (!await sor("Sınavı Sil", "Sınav arşive taşınacak. Tüm verisi ve değişiklik geçmişi saklanır; \"Silinen sınavları göster\" ile görülüp geri alınabilir.", "Sil", "btn-kirmizi")) return;
  await _arsivDurumu(id, true);
};
window.kelebekGeriAl = async (id) => { await _arsivDurumu(id, false); };

async function _arsivDurumu(id, silindi) {
  try {
    const kim = state.kullanici?.ad || "";
    await setDoc(doc(db, "kelebek_sinavlar", id), silindi
      ? { silindi: true, silen_ad: kim, silme: serverTimestamp() }
      : { silindi: false, geri_alan_ad: kim, geri_alma: serverTimestamp() }, { merge: true });
    await addDoc(collection(db, "kelebek_sinavlar", id, "gecmis"), { zaman: serverTimestamp(), yapan_ad: kim,
      islem: silindi ? "silme" : "geri_al", detay: silindi ? "Sınav arşive taşındı" : "Sınav arşivden geri alındı" });
    await _listeCiz();
  } catch (err) {
    mesajGoster("kbListeMesaj", "İşlem yapılamadı: " + err.message, "hata");
  }
}

window.kelebekListeyeDon = async () => {
  await _bekleyenKaydiYaz();
  if (_kirli() && !await sor("Kaydedilmemiş Değişiklik", "Son değişiklikler kaydedilemedi (sınav adı/tarihi eksik ya da bağlantı hatası). Çıkarsanız bu değişiklikler kaybolur.", "Yine de çık", "btn-kirmizi")) return;
  _sinav = null;
  _listeCiz();
};

// ═══════════ DÜZENLEYİCİ ═══════════
function _secilenOgrenciler() {
  return _ogrenciler.filter((o) => _secili.has(o.ogrenci_id));
}

// sube -> ogrenciler (numaraya gore)
function _subeler() {
  const g = {};
  _ogrenciler.forEach((o) => (g[o.sinif] ||= []).push(o));
  Object.values(g).forEach((l) => l.sort((a, b) => a.no.localeCompare(b.no, "tr", { numeric: true })));
  return g;
}

function _duzenleyiciCiz() {
  const ro = !duzenler();
  const dis = ro ? " disabled" : "";
  kok().innerHTML = `
    <div style="margin-bottom:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-gri btn-sm" onclick="kelebekListeyeDon()">← Sınav listesi</button>
      <span id="kbDurum" style="font-size:13px;"></span></div>
    ${_sinav.silindi ? `<div class="uyari-kutu-sm">🗄 Bu sınav arşivde (silinmiş). Sadece görüntülenebilir; düzenlemek için listeden "Geri al".</div>` : ""}
    <div class="kart" id="kbBilgiKart" hidden><div class="kart-baslik">📋 Sınav Bilgisi</div><div id="kbBilgi"></div></div>
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
    <div class="kart"><div class="kart-baslik">7. Değişiklik Geçmişi</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:8px;">Her dağıtım ve sonraki değişiklikler (kim, ne zaman) burada tutulur; değiştirilemez. Dağıtım kayıtları görüntülenip geri yüklenebilir.</p>
      <div id="kbGecmis"></div></div>
    <div class="kart"><div class="kart-baslik">8. Salon Yoklaması</div><div id="kbYoklama"></div></div>
    <div class="mesaj" id="kbMesaj" style="position:sticky;bottom:8px;"></div>`;
  _ogrencilerCiz();
  _salonlarCiz();
  _dagitimCiz();
  _gozetmenYukle();
  _ciktiCiz();
  _gecmisYukle();
  _yoklamaYukle();
  _durumCiz();
}

window.kelebekAlan = (alan, deger) => {
  _sinav[alan] = deger;
  if (alan === "tarih") _gozetmenYukle();
  if (alan === "sira_no") _dagilimDegisti();
  _otoKaydet();
};
window.kelebekSaat = (s, acik) => {
  _sinav.saatler = acik ? [...new Set([..._sinav.saatler, s])].sort((a, b) => a - b) : _sinav.saatler.filter((x) => x !== s);
  _gozetmenYukle();
  _otoKaydet();
};

// Secim / salon / sira no degisti: dagitim kilitlenmez; farklar Dagitim
// kartinda gosterilir (sonradan eklenecekler, cikarilanlar, uyarilar).
function _dagilimDegisti() {
  _dagitimCiz();
  _ciktiCiz();
}

// ── Öğrenciler ──
// Ayarlar > Ogrenciler gibi sube akordiyonu: baslik kutusu subenin tumunu
// secer/kaldirir (kismi secimde yarim isaret), acilinca her ogrencinin
// karsisinda onay kutusu. Ustte kademe hizli secimi. Ayni akordiyon iki yerde
// kullanilir: sinav duzenleyicisi ("sinav") ve liste sayfasindaki ana liste ("ana").
const _baglam = {
  sinav: { el: "kbOgrenciler", secim: () => _secili, acik: () => _acikSubeler, ro: () => !duzenler(), degisti: () => _secimDegisti() },
  ana: { el: "kbAnaListe", secim: () => _anaSecili, acik: () => _anaAcik, ro: () => !admin(), degisti: () => _anaDegisti() },
};
const _kutular = (b) => document.querySelectorAll(`#${_baglam[b].el} .kb-sube`);

function _ogrencilerCiz(b = "sinav") {
  const B = _baglam[b];
  const el = document.getElementById(B.el);
  if (!el) return;
  const ro = B.ro();
  const secim = B.secim();
  // Secili ama artik kayitli olmayan (mezun/silinmis) ogrenciler: dagitimdaki
  // kopyalarindan gosterilir, secimde korunur.
  const aktif = new Set(_ogrenciler.map((o) => o.ogrenci_id));
  const kayitsiz = b !== "sinav" ? [] : [...secim].filter((id) => !aktif.has(id))
    .map((id) => _sinav.dagilim.find((x) => x.ogrenci_id === id) || { ogrenci_id: id, ad: "(bilinmeyen öğrenci)", no: "", sinif: "" });
  const dis = ro ? " disabled" : "";
  const subeler = _subeler();
  const adlar = Object.keys(subeler).sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
  const kademeler = [...new Set(adlar.map(kademeAl))];
  el.innerHTML = `
    ${ro ? "" : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:13px;">
      <span style="font-weight:600;">Hızlı seçim:</span>
      ${kademeler.map((k) => `<button class="btn btn-gri btn-sm" data-k="${esc(k)}" onclick="kelebekKademe('${b}', this.dataset.k, true)">${esc(k)}. sınıfların tümü</button>`).join("")}
      <button class="btn btn-gri btn-sm" onclick="kelebekTumunuKaldir('${b}')">Seçimi temizle</button>
      ${b === "sinav" ? `${_anaVar ? '<button class="btn btn-mavi btn-sm" onclick="kelebekAnaListeyiUygula()">📋 Ana listeyi uygula</button>' : ""}
      <button class="btn btn-gri btn-sm" onclick="kelebekOgrencileriYenile(this)">🔄 Öğrenci listesini yenile</button>` : ""}</div>`}
    ${adlar.map((s) => {
      const liste = subeler[s];
      const acik = B.acik().has(s);
      return `<div class="accordion-item kb-sube" data-sube="${esc(s)}" style="margin-bottom:6px;">
        <div class="akor-sube-baslik" style="margin:0;gap:10px;">
          <input type="checkbox" class="kb-sube-chk" data-sube="${esc(s)}" onclick="event.stopPropagation()" onchange="kelebekSube('${b}', this.dataset.sube, this.checked)"${dis}>
          <span style="flex:1;cursor:pointer;" data-sube="${esc(s)}" onclick="kelebekSubeAc('${b}', this.dataset.sube)">📚 <strong>${esc(s)}</strong>
            <span class="kb-sube-sayi" style="font-size:12px;color:#888;"></span></span>
          <span style="cursor:pointer;" data-sube="${esc(s)}" onclick="kelebekSubeAc('${b}', this.dataset.sube)">${acik ? "▲" : "▼"}</span>
        </div>
        <div class="accordion-icerik" ${acik ? "" : "hidden"} style="padding:4px 8px;">
          ${liste.map((o) => `<label class="ogrenci-satir" style="cursor:pointer;padding:6px 10px;margin-bottom:3px;">
            <input type="checkbox" class="kb-ogr-chk" value="${esc(o.ogrenci_id)}" ${secim.has(o.ogrenci_id) ? "checked" : ""} onchange="kelebekOgrenci('${b}', this)"${dis}>
            <span class="ogrenci-no">${esc(o.no)}</span><span class="ogrenci-isim">${esc(o.ad)}</span></label>`).join("")}
        </div></div>`;
    }).join("")}
    ${kayitsiz.length ? `<div class="uyari-kutu-sm" style="margin-top:8px;">Sistemde artık kayıtlı olmayan (mezun/silinmiş) ${kayitsiz.length} öğrenci bu sınavın kaydında korunuyor:
      ${kayitsiz.map((x) => `${esc(x.no)} ${esc(x.ad)}${x.sinif ? ` (${esc(x.sinif)}${x.salon ? ", " + esc(x.salon) : ""})` : ""}`).join(" · ")}
      <div style="font-size:12px;margin-top:4px;">Yeniden dağıtımda yer almazlar.</div></div>` : ""}
    <div class="kb-ogr-toplam" style="margin-top:8px;font-weight:700;"></div>`;
  _secimGostergeleri(b);
}

// Akordiyonu yeniden cizmeden sube basliklarini ve toplami gunceller.
function _secimGostergeleri(b = "sinav") {
  const B = _baglam[b];
  const secim = B.secim();
  const subeler = _subeler();
  _kutular(b).forEach((kutu) => {
    const liste = subeler[kutu.dataset.sube] || [];
    const n = liste.filter((o) => secim.has(o.ogrenci_id)).length;
    const chk = kutu.querySelector(".kb-sube-chk");
    chk.checked = n > 0 && n === liste.length;
    chk.indeterminate = n > 0 && n < liste.length;
    kutu.querySelector(".kb-sube-sayi").textContent = `(${n} / ${liste.length} seçili)`;
  });
  const secilen = _ogrenciler.filter((o) => secim.has(o.ogrenci_id));
  const subeSayisi = new Set(secilen.map((o) => o.sinif)).size;
  const el = document.querySelector(`#${B.el} .kb-ogr-toplam`);
  if (el) el.textContent = `Toplam: ${secilen.length} öğrenci, ${subeSayisi} şube`;
}

function _secimDegisti() {
  _secimGostergeleri();
  _salonlarCiz();
  _dagilimDegisti();
  _otoKaydet();
}

window.kelebekSubeAc = (b, s) => {
  const acik = _baglam[b].acik();
  acik.has(s) ? acik.delete(s) : acik.add(s);
  const kutu = [..._kutular(b)].find((k) => k.dataset.sube === s);
  if (!kutu) return;
  const icerik = kutu.querySelector(".accordion-icerik");
  icerik.hidden = !acik.has(s);
  kutu.querySelectorAll(".akor-sube-baslik span[data-sube]")[1].textContent = icerik.hidden ? "▼" : "▲";
};

window.kelebekOgrenci = (b, cb) => {
  const secim = _baglam[b].secim();
  cb.checked ? secim.add(cb.value) : secim.delete(cb.value);
  _baglam[b].degisti();
};

function _subeIsaretle(b, s, acik) {
  const secim = _baglam[b].secim();
  (_subeler()[s] || []).forEach((o) => (acik ? secim.add(o.ogrenci_id) : secim.delete(o.ogrenci_id)));
  const kutu = [..._kutular(b)].find((k) => k.dataset.sube === s);
  kutu?.querySelectorAll(".kb-ogr-chk").forEach((c) => (c.checked = acik));
}

window.kelebekSube = (b, s, acik) => { _subeIsaretle(b, s, acik); _baglam[b].degisti(); };

window.kelebekKademe = (b, k, acik) => {
  Object.keys(_subeler()).filter((s) => kademeAl(s) === k).forEach((s) => _subeIsaretle(b, s, acik));
  _baglam[b].degisti();
};

window.kelebekTumunuKaldir = (b) => {
  _baglam[b].secim().clear();
  document.querySelectorAll(`#${_baglam[b].el} .kb-ogr-chk`).forEach((c) => (c.checked = false));
  _baglam[b].degisti();
};

// Var olan sinavin secimi ana listeyle degistirilir (sadece adminin istegiyle).
// Dagitim kendiliginden degismez; farklar Dagitim kartinda gosterilir.
window.kelebekAnaListeyiUygula = async () => {
  const aktif = new Set(_ogrenciler.map((o) => o.ogrenci_id));
  const yeni = new Set([..._anaSecili].filter((id) => aktif.has(id)));
  const eklenen = [...yeni].filter((id) => !_secili.has(id)).length;
  const cikan = [..._secili].filter((id) => !yeni.has(id)).length;
  if (!eklenen && !cikan) { mesajGoster("kbMesaj", "Bu sınavın öğrenci seçimi ana listeyle zaten aynı.", "bilgi"); return; }
  if (!await sor("Ana Listeyi Uygula", `Bu sınavın öğrenci seçimi güncel ana listeyle değiştirilecek: ${eklenen} öğrenci eklenecek, ${cikan} öğrenci çıkarılacak. Dağıtım kendiliğinden değişmez; farklar Dağıtım bölümünde gösterilir.`, "Uygula", "btn-mavi")) return;
  _secili = yeni;
  _ogrencilerCiz();
  _secimDegisti();
  mesajGoster("kbMesaj", `Ana liste uygulandı: ${eklenen} eklendi, ${cikan} çıkarıldı.`, "basari");
};

// ── Salonlar ──
function _salonAd(s) {
  return s.sinif && s.sinif !== DIGER ? s.sinif : (s.ad || "").trim();
}

function _salonlarCiz() {
  const el = document.getElementById("kbSalonlar");
  const ro = !duzenler();
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
  _salonlarCiz(); _dagilimDegisti(); _gozetmenYukle(); _otoKaydet();
};
window.kelebekSalonAd = (i, v) => { _sinav.salonlar[i].ad = v; _dagilimDegisti(); _otoKaydet(); };
window.kelebekSalonKap = (i, v) => {
  _sinav.salonlar[i].kapasite = Math.max(0, parseInt(v, 10) || 0);
  const el = document.getElementById("kbKapasite");
  const toplamKap = _sinav.salonlar.reduce((a, s) => a + (Number(s.kapasite) || 0), 0);
  const ogrSayi = _secilenOgrenciler().length;
  el.style.color = toplamKap < ogrSayi ? "#ea4335" : "inherit";
  el.textContent = `Toplam yer: ${toplamKap} · Öğrenci: ${ogrSayi}${toplamKap < ogrSayi ? ` — ${ogrSayi - toplamKap} kişilik yer eksik` : ""}`;
  _dagilimDegisti();
  _otoKaydet();
};
window.kelebekSalonEkle = () => { _sinav.salonlar.push({ ad: "", sinif: "", kapasite: 0 }); _salonlarCiz(); };
window.kelebekSalonSil = (i) => { _sinav.salonlar.splice(i, 1); _salonlarCiz(); _dagilimDegisti(); _gozetmenYukle(); _otoKaydet(); };

function _gecerliSalonlar() {
  return _sinav.salonlar.map((s) => ({ ad: _salonAd(s), sinif: s.sinif && s.sinif !== DIGER ? s.sinif : null, kapasite: Number(s.kapasite) || 0 }))
    .filter((s) => s.ad);
}

// ── Kayıt (otomatik) + değişiklik geçmişi ──
// Dagitim, elle ekleme/tasima/cikarma, geri yukleme ve gozetmen degisikligi
// otomatik kaydedilir ve kelebek_sinavlar/{id}/gecmis'e degistirilemez satir
// olarak yazilir. dagitim / geri_yukle satirlari dagitimin tam kopyasini
// (surum) tasir; gecmisten goruntulenip geri yuklenebilir.
const ISLEM_AD = { dagitim: "🦋 Dağıtım", geri_yukle: "↩️ Geri yükleme", elle_ekle: "➕ Elle ekleme", tasima: "↔️ Taşıma", cikar: "➖ Çıkarma", gozetmen: "👁 Gözetmen",
  olusturma: "🆕 Oluşturma", duzenleme: "✏️ Düzenleme", silme: "🗄 Silme (arşiv)", geri_al: "♻️ Arşivden geri alma", yerine: "🔁 Yerine girecek" };
let _acikSalon = null;  // dagitim tablosunda ayrintisi acik salon
let _gecmis = [];

function _salonlarKayit() {
  return _sinav.salonlar.map((s) => ({ ad: _salonAd(s), sinif: s.sinif || "", kapasite: Number(s.kapasite) || 0 }));
}

function _belgeVerisi() {
  return {
    ad: (_sinav.ad || "").trim(), tarih: _sinav.tarih, saatler: _sinav.saatler, sira_no: !!_sinav.sira_no,
    ogrenciler: [..._secili],
    siniflar: [...new Set(_secilenOgrenciler().map((o) => o.sinif))], haric: [],
    salonlar: _salonlarKayit(),
    dagilim: _sinav.dagilim, gozetmenler: _sinav.gozetmenler || {},
    guncelleyen_ad: state.kullanici?.ad || "", guncelleme: serverTimestamp(),
  };
}

// Gecmisteki "duzenleme" satiri icin kaydedilen durumun ozeti.
function _durumOzeti() {
  return {
    ad: (_sinav.ad || "").trim(), tarih: _sinav.tarih || "", saatler: saatMetni(_sinav.saatler), sira_no: !!_sinav.sira_no,
    salonlar: _salonlarKayit().filter((s) => s.ad).map((s) => `${s.ad} (${s.kapasite})`).join(", "),
    ogrenciler: new Set(_secili),
  };
}

const _ogrAd = (id) => (_ogrenciler.find((o) => o.ogrenci_id === id) || _sinav.dagilim.find((x) => x.ogrenci_id === id))?.ad || "?";
const _adListesi = (ids) => ids.slice(0, 10).map(_ogrAd).join(", ") + (ids.length > 10 ? ` +${ids.length - 10}` : "");

function _farkMetni(a, b, ogrenciDahil) {
  const f = [];
  if (a.ad !== b.ad) f.push(`Ad: "${a.ad}" → "${b.ad}"`);
  if (a.tarih !== b.tarih) f.push(`Tarih: ${trTarih(a.tarih)} → ${trTarih(b.tarih)}`);
  if (a.saatler !== b.saatler) f.push(`Saatler: ${a.saatler} → ${b.saatler}`);
  if (a.sira_no !== b.sira_no) f.push(`Sıra no: ${b.sira_no ? "açıldı" : "kapatıldı"}`);
  if (a.salonlar !== b.salonlar) f.push(`Salonlar: ${a.salonlar || "—"} → ${b.salonlar || "—"}`);
  if (ogrenciDahil) {
    const eklenen = [...b.ogrenciler].filter((id) => !a.ogrenciler.has(id));
    const cikan = [...a.ogrenciler].filter((id) => !b.ogrenciler.has(id));
    if (eklenen.length || cikan.length) {
      f.push(`Öğrenci seçimi: ${a.ogrenciler.size} → ${b.ogrenciler.size}` +
        (eklenen.length ? `; eklenen ${eklenen.length}: ${_adListesi(eklenen)}` : "") +
        (cikan.length ? `; çıkarılan ${cikan.length}: ${_adListesi(cikan)}` : ""));
    }
  }
  return f.join(" · ");
}

// ── Otomatik kayıt ──
// Sinav bilgileri, secim ve salon degisiklikleri 1,5 sn sonra kendiliginden
// yazilir. Yazimlar sirayla yapilir; baska yerde degismis belgenin uzerine
// yazilmaz (guncelleme damgasi karsilastirilir).
let _otoZamanlayici = null;
let _kayitSirasi = Promise.resolve();
let _degisiklik = 0, _kaydedilen = 0;  // yerel degisiklik sayaci / son kaydedilen
let _cakisma = false;
let _sonKayit = null;    // son kaydedilen durumun ozeti
let _surumDamga = null;  // belgede son gorulen guncelleme (ms)
let _kayitDurum = { tur: "" };

const _kirli = () => _degisiklik !== _kaydedilen;

window.addEventListener("beforeunload", (e) => {
  if ((_sinav && (_kirli() || _otoZamanlayici)) || _anaZamanlayici || _anaKirli()) { e.preventDefault(); e.returnValue = ""; }
});

function _durum(tur, metin = "") { _kayitDurum = { tur, metin, zaman: new Date() }; _durumCiz(); }

function _durumCiz() {
  const el = document.getElementById("kbDurum");
  if (!el || !duzenler()) { if (el) el.textContent = ""; return; }
  const d = _kayitDurum;
  const saat = d.zaman ? d.zaman.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
  const g = {
    eksik: ["#e65100", "⚠ Kaydetmek için sınav adı ve tarihini girin"],
    bekliyor: ["var(--text2)", "● Kaydedilecek…"],
    kaydediliyor: ["var(--text2)", "Kaydediliyor…"],
    kaydedildi: ["#34a853", `✓ Kaydedildi ${saat}`],
    hata: ["#ea4335", `⚠ Kaydedilemedi: ${d.metin}`],
  }[d.tur];
  el.style.color = g ? g[0] : "";
  el.textContent = g ? g[1] : (_sinav.id ? "Değişiklikler otomatik kaydedilir" : "");
}

function _otoKaydet() {
  if (!duzenler()) return;
  _degisiklik++;
  clearTimeout(_otoZamanlayici);
  _otoZamanlayici = null;
  if (_cakisma) { _durum("hata", "sınav başka yerde değiştirildi; yeniden açın"); return; }
  if (!(_sinav.ad || "").trim() || !_sinav.tarih) { _durum("eksik"); return; }
  _durum("bekliyor");
  _otoZamanlayici = setTimeout(() => { _otoZamanlayici = null; _otoYaz(); }, 1500);
}

async function _otoYaz() {
  try { await _kaydet(null, ""); } catch (err) { /* durum satirinda gosterildi */ }
}

async function _bekleyenKaydiYaz() {
  if (_otoZamanlayici) { clearTimeout(_otoZamanlayici); _otoZamanlayici = null; await _otoYaz(); }
  await _kayitSirasi;
}

// Belgeyi yazar (yeni ise olusturur). Kaydedilen bilgi/secim/salon farki
// "duzenleme", islem verilirse o islem de gecmise yazilir.
function _kaydet(islem, detay, surum = false) {
  const is = _kayitSirasi.then(() => _kaydetIc(islem, detay, surum));
  _kayitSirasi = is.catch(() => {});
  return is;
}

async function _kaydetIc(islem, detay, surum) {
  if (!(_sinav.ad || "").trim() || !_sinav.tarih) { _durum("eksik"); throw new Error("Önce sınav adı ve tarihini girin; değişiklik kaydedilemedi."); }
  if (_cakisma) throw new Error("Bu sınav başka bir yerde değiştirildi; üzerine yazılmaması için kaydedilmedi. Sınavı listeden yeniden açın.");
  clearTimeout(_otoZamanlayici);
  _otoZamanlayici = null;
  const sayac = _degisiklik;
  const sinav = _sinav;
  _durum("kaydediliyor");
  try {
    const veri = _belgeVerisi();
    const ozet = _durumOzeti();
    const kim = state.kullanici?.ad || "";
    let yeni = false;
    if (sinav.id) {
      const ref = doc(db, "kelebek_sinavlar", sinav.id);
      const mevcut = await getDoc(ref);
      const damga = _ms(mevcut.data()?.guncelleme) || null;
      if (damga !== _surumDamga) {
        _cakisma = true;
        throw new Error("Bu sınav başka bir yerde (başka sekme ya da kişi) değiştirildi; üzerine yazılmaması için kaydedilmedi. Sınavı listeden yeniden açın.");
      }
      // mergeFields: alanlar tumuyle yazilir (ic ice haritalarda silinen
      // anahtarlar, or. "otomatige don"ulen gozetmen, belgede kalmasin).
      await setDoc(ref, veri, { mergeFields: Object.keys(veri) });
    } else {
      const ref = await addDoc(collection(db, "kelebek_sinavlar"), { ...veri, olusturan_ad: kim, olusturma: serverTimestamp() });
      sinav.id = ref.id;
      yeni = true;
    }
    _surumDamga = _ms((await getDoc(doc(db, "kelebek_sinavlar", sinav.id))).data()?.guncelleme) || null;

    const gecmisRef = collection(db, "kelebek_sinavlar", sinav.id, "gecmis");
    const satir = (islemAd, d) => addDoc(gecmisRef, { zaman: serverTimestamp(), yapan_ad: kim, islem: islemAd, detay: d });
    let yazildi = false;
    if (yeni) {
      await satir("olusturma", `${ozet.ad}, ${trTarih(ozet.tarih)}${ozet.saatler.startsWith(" ") ? "" : ", " + ozet.saatler}, ${ozet.ogrenciler.size} öğrenci${ozet.salonlar ? ", salonlar: " + ozet.salonlar : ""}`);
      yazildi = true;
    } else if (_sonKayit) {
      // cikar / geri_yukle secimi kendisi degistirir; ayrica yazilmaz.
      const fark = _farkMetni(_sonKayit, ozet, !["cikar", "geri_yukle"].includes(islem));
      if (fark) { await satir("duzenleme", fark); yazildi = true; }
    }
    _sonKayit = ozet;
    if (islem) {
      const kayit = { zaman: serverTimestamp(), yapan_ad: kim, islem, detay: detay || "" };
      if (surum) Object.assign(kayit, { dagilim: sinav.dagilim, salonlar: veri.salonlar, sira_no: veri.sira_no });
      await addDoc(gecmisRef, kayit);
      yazildi = true;
    }
    if (_sinav !== sinav) return;  // bu arada baska sinava gecildi
    if (sayac >= _kaydedilen) _kaydedilen = sayac;
    _durum(_kirli() && _otoZamanlayici ? "bekliyor" : "kaydedildi");
    if (yazildi) _gecmisYukle();
  } catch (err) {
    if (_sinav === sinav) _durum("hata", err.message);
    throw err;
  }
}

async function _kaydetGoster(islem, detay, surum = false, basari = "") {
  try {
    await _kaydet(islem, detay, surum);
    if (basari) mesajGoster("kbMesaj", basari, "basari");
  } catch (err) {
    mesajGoster("kbMesaj", err.message, "hata");
  }
}

// ── Dağıtım ──
function _dagitimCiz() {
  const el = document.getElementById("kbDagitim");
  if (!el) return;
  const ro = !duzenler();
  const d = _sinav.dagilim;
  let html = ro ? "" : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
    <button class="btn btn-mavi" onclick="kelebekDagitYap()">${d.length ? "🔀 Yeniden dağıt" : "🦋 Dağıt"}</button>
    <button class="btn btn-yesil" onclick="kelebekKaydet()">💾 Kaydet</button></div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Tüm değişiklikler (sınav bilgileri, öğrenci seçimi, salonlar, dağıtım, taşıma, yedek öğrenci) otomatik kaydedilir ve Değişiklik Geçmişi'ne yazılır. "Kaydet" hemen kaydetmek içindir.</div>`;
  if (!d.length) { el.innerHTML = html + '<div class="bos-mesaj">Henüz dağıtım yapılmadı.</div>'; _bilgiCiz(); return; }

  // Secim / salonlar ile dagitim arasindaki farklar
  const dagitimdakiler = new Set(d.map((x) => x.ogrenci_id));
  const yeniler = _secilenOgrenciler().filter((o) => !dagitimdakiler.has(o.ogrenci_id));
  const cikanlar = d.filter((x) => !_secili.has(x.ogrenci_id));
  const salonAdlari = new Set(_gecerliSalonlar().map((s) => s.ad));
  const yetimSalonlar = [...new Set(d.map((x) => x.salon))].filter((s) => !salonAdlari.has(s));
  const siraUyumsuz = d.some((x) => (x.sira != null) !== !!_sinav.sira_no);

  if (yeniler.length) {
    const sim = d.slice();
    html += `<div class="kart" style="background:#e8f0fe;margin-bottom:10px;"><div style="font-weight:700;margin-bottom:6px;">Sonradan eklenecek ${yeniler.length} öğrenci <span style="font-weight:400;font-size:12px;">(seçili ama dağıtımda yok)</span></div>
      ${yeniler.map((o) => {
        const oneri = salonOner(sim, _gecerliSalonlar(), o.sinif, !!_sinav.sira_no);
        if (oneri) sim.push({ ...o, salon: oneri.salon, sira: oneri.sira });
        return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
          <span style="min-width:200px;">${esc(o.no)} ${esc(o.ad)} <span class="rozet rozet-mavi" style="font-size:11px;">${esc(o.sinif)}</span></span>
          ${ro ? "" : `<select class="kb-ekle-salon" data-id="${esc(o.ogrenci_id)}">${_salonSecenekleri(oneri?.salon)}</select>
          <button class="btn btn-yesil btn-sm" data-id="${esc(o.ogrenci_id)}" onclick="kelebekElleEkle(this.dataset.id)">Ekle</button>`}
          ${oneri ? "" : '<span style="font-size:12px;color:#ea4335;">Salonlarda boş yer yok</span>'}
        </div>`;
      }).join("")}
      ${ro || yeniler.length < 2 ? "" : '<button class="btn btn-mavi btn-sm" style="margin-top:4px;" onclick="kelebekTumunuEkle()">Tümünü önerilen salonlara ekle</button>'}
    </div>`;
  }
  if (cikanlar.length) {
    html += `<div class="uyari-kutu-sm">Seçimden çıkarılmış ama dağıtımda olan ${cikanlar.length} öğrenci:
      ${cikanlar.map((x) => `<span style="display:inline-flex;gap:4px;align-items:center;margin:2px 6px 2px 0;">${esc(x.ad)} (${esc(x.sinif)}, ${esc(x.salon)})
        ${ro ? "" : `<button class="btn btn-kirmizi btn-sm" data-id="${esc(x.ogrenci_id)}" onclick="kelebekDagitimdanCikar(this.dataset.id)">Dağıtımdan çıkar</button>`}</span>`).join("")}</div>`;
  }
  if (yetimSalonlar.length) html += `<div class="uyari-kutu-sm">Salon listesinden kaldırılmış salonda öğrenci var: ${yetimSalonlar.map(esc).join(", ")}. Öğrencileri "Ayrıntı"dan taşıyın ya da yeniden dağıtın.</div>`;
  if (siraUyumsuz) html += '<div class="uyari-kutu-sm">Sıra numarası seçimi dağıtımla uyuşmuyor; sıra numaralarının güncellenmesi için yeniden dağıtın.</div>';

  const salonlar = [...new Set([..._gecerliSalonlar().map((s) => s.ad), ...d.map((x) => x.salon)])]
    .map((ad) => ({ ad, kapasite: _gecerliSalonlar().find((s) => s.ad === ad)?.kapasite ?? "" }));
  const ist = kelebekIstatistik(d, salonlar);
  const sutun = _sinav.sira_no ? 6 : 5;
  html += `<div style="overflow-x:auto;"><table><thead><tr><th>Salon</th><th>Öğrenci</th><th>Şube dağılımı</th><th>En çok aynı şube</th>${_sinav.sira_no ? "<th>Yan yana aynı şube</th>" : ""}<th></th></tr></thead><tbody>
    ${ist.map((s) => {
      const asim = s.kapasite !== "" && s.sayi > s.kapasite;
      const yedek = d.filter((x) => x.salon === s.salon && x.yerine).length;
      let satir = `<tr><td><strong>${esc(s.salon)}</strong></td><td style="${asim ? "color:#ea4335;font-weight:700;" : ""}">${s.sayi}${s.kapasite !== "" ? "/" + s.kapasite : ""}${yedek ? ` <span style="font-size:11px;color:#e65100;font-weight:400;">· ${yedek} yedek</span>` : ""}</td>
        <td style="font-size:12px;">${Object.entries(s.subeler).sort((a, b) => a[0].localeCompare(b[0], "tr", { numeric: true })).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ")}</td>
        <td style="text-align:center;">${s.enBuyuk}</td>${_sinav.sira_no ? `<td style="text-align:center;color:${s.komsuAyni ? "#e65100" : "#34a853"};">${s.komsuAyni}</td>` : ""}
        <td><button class="btn btn-gri btn-sm" data-s="${esc(s.salon)}" onclick="kelebekSalonAyrinti(this.dataset.s)">${_acikSalon === s.salon ? "Gizle" : "Ayrıntı"}</button></td></tr>`;
      if (_acikSalon === s.salon) {
        satir += `<tr><td colspan="${sutun}" style="background:#fafafa;">${_siraliSalon(s.salon).map((x) => `
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:3px 0;border-bottom:1px solid #eee;font-size:13px;${x.yerine ? "background:#fff4e5;" : ""}">
            <span style="min-width:36px;color:var(--text2);">${x.sira != null ? x.sira + "." : ""}</span>
            <span style="min-width:220px;">${esc(x.no)} ${esc(x.ad)} <span class="rozet rozet-mavi" style="font-size:11px;">${esc(x.sinif)}</span></span>
            ${ro ? (x.yerine ? `<span style="color:#e65100;">🔁 Yerine: <strong>${esc(x.yerine)}</strong></span>` : "")
              : `<span style="display:inline-flex;gap:4px;align-items:center;">
                <span style="color:#e65100;font-size:12px;">🔁 Yerine:</span>
                <input class="kb-yerine" data-id="${esc(x.ogrenci_id)}" value="${esc(x.yerine || "")}" placeholder="Yerine girecek öğrenci" title="Öğrenci aynı salonda ve sırada kalır; sadece yerine girecek kişi listeye yazılır." onchange="kelebekYerine(this.dataset.id, this.value)" style="width:190px;">
                <button class="btn btn-gri btn-sm" onclick="const i=this.previousElementSibling; kelebekYerine(i.dataset.id, i.value)">✓ Kaydet</button>
              </span>`}
            ${ro ? "" : `<span style="display:inline-flex;gap:4px;align-items:center;margin-left:auto;padding-left:8px;border-left:1px solid #ddd;">
              <select class="kb-tasi-salon" data-id="${esc(x.ogrenci_id)}"><option value="">Başka salona taşı...</option>${_salonSecenekleri("", s.salon)}</select>
              <button class="btn btn-gri btn-sm" data-id="${esc(x.ogrenci_id)}" onclick="kelebekTasi(this.dataset.id)">Salona taşı</button>
              <button class="btn btn-kirmizi btn-sm" data-id="${esc(x.ogrenci_id)}" onclick="kelebekDagitimdanCikar(this.dataset.id)">Çıkar</button>
            </span>`}
          </div>`).join("") || '<div class="bos-mesaj">Bu salonda öğrenci yok.</div>'}</td></tr>`;
      }
      return satir;
    }).join("")}
    </tbody></table></div>`;
  el.innerHTML = html;
  _bilgiCiz();
}

// Sinava girmeyecek ogrencinin yerine girecek ogrenci (elle yazilir); yedek
// asil ogrencinin salon ve sirasina oturur.
window.kelebekYerine = async (id, deger) => {
  const x = _sinav.dagilim.find((d) => d.ogrenci_id === id);
  if (!x) return;
  const yeni = String(deger || "").trim();
  const eski = x.yerine || "";
  if (yeni === eski) return;
  if (yeni) x.yerine = yeni; else delete x.yerine;
  _bilgiCiz();
  const kim = `${x.ad} (${x.sinif}, ${x.salon}${x.sira != null ? ", sıra " + x.sira : ""})`;
  await _kaydetGoster("yerine", yeni ? `${kim}: yerine ${yeni} girecek${eski ? ` (önceki: ${eski})` : ""}` : `${kim}: yedek kaldırıldı (${eski})`,
    false, yeni ? `Kaydedildi: ${x.ad} yerine ${yeni}.` : "Yedek kaldırıldı.");
};

function _salonSecenekleri(secili, haric) {
  return _gecerliSalonlar().filter((s) => s.ad !== haric).map((s) => {
    const sayi = _sinav.dagilim.filter((d) => d.salon === s.ad).length;
    return `<option value="${esc(s.ad)}"${s.ad === secili ? " selected" : ""}>${esc(s.ad)} (${sayi}/${s.kapasite})</option>`;
  }).join("");
}

window.kelebekSalonAyrinti = (salon) => {
  _acikSalon = _acikSalon === salon ? null : salon;
  _dagitimCiz();
};

window.kelebekDagitYap = async () => {
  const ogr = _secilenOgrenciler();
  const salonlar = _gecerliSalonlar();
  if (!(_sinav.ad || "").trim() || !_sinav.tarih) { mesajGoster("kbMesaj", "Önce sınav adı ve tarihini girin.", "hata"); return; }
  if (!ogr.length) { mesajGoster("kbMesaj", "Sınava girecek öğrencileri seçin.", "hata"); return; }
  if (salonlar.length !== _sinav.salonlar.length) { mesajGoster("kbMesaj", "Her salon için bir sınıf seçin ya da Diğer salona ad yazın.", "hata"); return; }
  if (new Set(salonlar.map((s) => s.ad)).size !== salonlar.length) { mesajGoster("kbMesaj", "Aynı salon iki kez eklenmiş.", "hata"); return; }
  if (_sinav.dagilim.length && !await sor("Yeniden Dağıt", "Yeni bir dağıtım yapılacak. Mevcut dağıtım değişiklik geçmişinde saklanır ve oradan geri yüklenebilir; ancak basılmış listeler geçersiz olur.", "Dağıt", "btn-mavi")) return;
  try {
    // Yazilmis yedek ogrenciler yeni dagitimda da korunur.
    const yerine = new Map(_sinav.dagilim.filter((x) => x.yerine).map((x) => [x.ogrenci_id, x.yerine]));
    _sinav.dagilim = kelebekDagit(ogr, salonlar, !!_sinav.sira_no, Date.now());
    _sinav.dagilim.forEach((x) => { if (yerine.has(x.ogrenci_id)) x.yerine = yerine.get(x.ogrenci_id); });
  } catch (err) {
    mesajGoster("kbMesaj", err.message, "hata");
    return;
  }
  _acikSalon = null;
  _dagitimCiz(); _ciktiCiz(); _gozetmenYukle();
  await _kaydetGoster("dagitim", `${_sinav.dagilim.length} öğrenci, ${salonlar.length} salon${_sinav.sira_no ? ", sıra numaralı" : ""}`, true, "Dağıtım yapıldı ve kaydedildi.");
};

function _ogrenciEkle(o, salon) {
  const sira = _sinav.sira_no ? sonrakiSira(_sinav.dagilim, salon) : null;
  _sinav.dagilim.push({ ogrenci_id: o.ogrenci_id, no: o.no, ad: o.ad, sinif: o.sinif, salon, sira });
  return `${o.ad} (${o.sinif}) → ${salon}${sira != null ? ", sıra " + sira : ""}`;
}

function _kapasiteUyarisi(salon) {
  const s = _gecerliSalonlar().find((x) => x.ad === salon);
  const sayi = _sinav.dagilim.filter((d) => d.salon === salon).length;
  return s && sayi > s.kapasite ? ` ${salon} salonu kapasitesini aştı (${sayi}/${s.kapasite}).` : "";
}

window.kelebekElleEkle = async (id) => {
  const o = _ogrenciler.find((x) => x.ogrenci_id === id);
  const sel = [...document.querySelectorAll("#kbDagitim .kb-ekle-salon")].find((s) => s.dataset.id === id);
  if (!o || !sel?.value) { mesajGoster("kbMesaj", "Salon seçin.", "hata"); return; }
  const detay = _ogrenciEkle(o, sel.value);
  _dagitimCiz(); _ciktiCiz();
  await _kaydetGoster("elle_ekle", detay, false, "Eklendi: " + detay + "." + _kapasiteUyarisi(sel.value));
};

window.kelebekTumunuEkle = async () => {
  const dagitimdakiler = new Set(_sinav.dagilim.map((x) => x.ogrenci_id));
  const yeniler = _secilenOgrenciler().filter((o) => !dagitimdakiler.has(o.ogrenci_id));
  const eklenen = [], yerYok = [];
  yeniler.forEach((o) => {
    const oneri = salonOner(_sinav.dagilim, _gecerliSalonlar(), o.sinif, !!_sinav.sira_no);
    if (oneri) eklenen.push(_ogrenciEkle(o, oneri.salon)); else yerYok.push(o.ad);
  });
  _dagitimCiz(); _ciktiCiz();
  if (eklenen.length) await _kaydetGoster("elle_ekle", `${eklenen.length} öğrenci: ${eklenen.join("; ")}`, false,
    `${eklenen.length} öğrenci eklendi.${yerYok.length ? ` Yer olmadığı için eklenemeyen: ${yerYok.join(", ")}.` : ""}`);
  else mesajGoster("kbMesaj", "Salonlarda boş yer yok; kapasiteyi artırın ya da öğrencileri tek tek ekleyin.", "hata");
};

window.kelebekTasi = async (id) => {
  const sel = [...document.querySelectorAll("#kbDagitim .kb-tasi-salon")].find((s) => s.dataset.id === id);
  const x = _sinav.dagilim.find((d) => d.ogrenci_id === id);
  if (!x || !sel?.value) { mesajGoster("kbMesaj", "Taşınacak salonu seçin.", "hata"); return; }
  const eski = x.salon + (x.sira != null ? ", sıra " + x.sira : "");
  x.sira = _sinav.sira_no ? sonrakiSira(_sinav.dagilim, sel.value) : null;
  x.salon = sel.value;
  const detay = `${x.ad} (${x.sinif}): ${eski} → ${x.salon}${x.sira != null ? ", sıra " + x.sira : ""}`;
  _dagitimCiz(); _ciktiCiz();
  await _kaydetGoster("tasima", detay, false, "Taşındı: " + detay + "." + _kapasiteUyarisi(x.salon));
};

window.kelebekDagitimdanCikar = async (id) => {
  const x = _sinav.dagilim.find((d) => d.ogrenci_id === id);
  if (!x) return;
  if (!await sor("Dağıtımdan Çıkar", `${x.ad} (${x.sinif}) ${x.salon} salonundan çıkarılacak ve sınava girecekler listesinden kaldırılacak.`, "Çıkar", "btn-kirmizi")) return;
  _sinav.dagilim = _sinav.dagilim.filter((d) => d.ogrenci_id !== id);
  _secili.delete(id);
  _secimGostergeleri(); _salonlarCiz();
  _dagitimCiz(); _ciktiCiz();
  await _kaydetGoster("cikar", `${x.ad} (${x.sinif}) ${x.salon}${x.sira != null ? ", sıra " + x.sira : ""} salonundan çıkarıldı`, false, "Çıkarıldı.");
};

window.kelebekKaydet = async () => {
  await _kaydetGoster(null, "", false, _sinav.saatler.length ? "Kaydedildi." : "Kaydedildi. Ders saati seçilmedi; gözetmenler için saat seçin.");
};

// ── Değişiklik geçmişi ──
async function _gecmisYukle() {
  const el = document.getElementById("kbGecmis");
  if (!el) return;
  if (!_sinav.id) { el.innerHTML = '<div class="bos-mesaj">Sınav kaydedilince değişiklikler burada listelenir.</div>'; return; }
  try {
    const snap = await getDocs(collection(db, "kelebek_sinavlar", _sinav.id, "gecmis"));
    _gecmis = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.zaman?.toMillis?.() ?? Infinity) - (a.zaman?.toMillis?.() ?? Infinity));
    _gecmisCiz();
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Geçmiş okunamadı: ${esc(err.message)}</div>`;
  }
}

const _zamanMetni = (z) => z?.toDate ? z.toDate().toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "şimdi";

function _gecmisCiz(acikId) {
  const el = document.getElementById("kbGecmis");
  if (!el) return;
  if (!_gecmis.length) { el.innerHTML = '<div class="bos-mesaj">Henüz kayıtlı değişiklik yok.</div>'; return; }
  el.innerHTML = `<div style="overflow-x:auto;"><table><thead><tr><th>Ne zaman</th><th>Kim</th><th>İşlem</th><th>Ayrıntı</th><th></th></tr></thead><tbody>
    ${_gecmis.map((g) => {
      const surum = Array.isArray(g.dagilim);
      let satir = `<tr><td style="white-space:nowrap;font-size:12px;">${esc(_zamanMetni(g.zaman))}</td><td style="font-size:12px;">${esc(g.yapan_ad)}</td>
        <td style="white-space:nowrap;">${esc(ISLEM_AD[g.islem] || g.islem)}</td><td style="font-size:12px;">${esc(g.detay)}</td>
        <td style="white-space:nowrap;">${surum ? `<button class="btn btn-gri btn-sm" data-id="${esc(g.id)}" onclick="kelebekSurumGoster(this.dataset.id)">${acikId === g.id ? "Gizle" : "Görüntüle"}</button>
          ${duzenler() ? `<button class="btn btn-mavi btn-sm" data-id="${esc(g.id)}" onclick="kelebekSurumGeriYukle(this.dataset.id)">Geri yükle</button>` : ""}` : ""}</td></tr>`;
      if (surum && acikId === g.id) {
        const ist = kelebekIstatistik(g.dagilim, (g.salonlar || []).map((s) => ({ ad: s.ad, kapasite: s.kapasite })));
        satir += `<tr><td colspan="5" style="background:#fafafa;font-size:12px;">${g.dagilim.length} öğrenci${g.sira_no ? ", sıra numaralı" : ""}<br>
          ${ist.map((s) => `<strong>${esc(s.salon)}</strong> ${s.sayi}/${s.kapasite}: ${Object.entries(s.subeler).sort((a, b) => a[0].localeCompare(b[0], "tr", { numeric: true })).map(([k, v]) => `${esc(k)} ${v}`).join(" · ")}`).join("<br>")}</td></tr>`;
      }
      return satir;
    }).join("")}
    </tbody></table></div>`;
}

let _acikSurum = null;
window.kelebekSurumGoster = (id) => {
  _acikSurum = _acikSurum === id ? null : id;
  _gecmisCiz(_acikSurum);
};

window.kelebekSurumGeriYukle = async (id) => {
  const g = _gecmis.find((x) => x.id === id);
  if (!g || !Array.isArray(g.dagilim)) return;
  if (!await sor("Dağıtımı Geri Yükle", `${_zamanMetni(g.zaman)} tarihli dağıtım (${g.dagilim.length} öğrenci) güncel dağıtım olacak. Şu anki dağıtım da geçmişte saklı kalır.`, "Geri yükle", "btn-mavi")) return;
  _sinav.dagilim = g.dagilim.map((x) => ({ ...x }));
  if (Array.isArray(g.salonlar) && g.salonlar.length) _sinav.salonlar = g.salonlar.map((s) => ({ ...s }));
  _sinav.sira_no = !!g.sira_no;
  _secili = new Set(_sinav.dagilim.map((x) => x.ogrenci_id));
  _acikSalon = null;
  _duzenleyiciCiz();
  await _kaydetGoster("geri_yukle", `${_zamanMetni(g.zaman)} tarihli dağıtım geri yüklendi (${_sinav.dagilim.length} öğrenci)`, true, "Dağıtım geri yüklendi.");
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
  // Tarihi gecmis sinav: sinav gunu kaydedilen gozetmen tablosu kullanilir;
  // program/vekil/rapor sonradan degisse de gecmis bilgi degismez.
  const kayit = _gozetmenCanli ? null : gecmisGozetmenKaydi(_sinav, salonlar, bugunHesapla());
  if (kayit) {
    _gozetmen = gozetmenTablosu(salonlar, _sinav.saatler, kayit.oto, new Set(kayit.raporlu || []), _sinav.gozetmenler, ogretmenAd);
    _gozetmenCiz(salonlar, `sınav için kaydedilen liste (${kayit.kaynak || "program"})`, true);
    return;
  }
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const tarih = _sinav.tarih;
  try {
    const { dersler, kaynak, raporlu } = await programDersleri(tarih);
    if (_sinav.tarih !== tarih) return;
    const oto = otoGozetmen(salonlar, _sinav.saatler, dersler, ogretmenAd);
    _gozetmen = gozetmenTablosu(salonlar, _sinav.saatler, oto, raporlu, _sinav.gozetmenler, ogretmenAd);
    _gozetmenCiz(salonlar, kaynak, false);
    _gozetmenKaydiYaz(tarih, kaynak, oto, raporlu);
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Gözetmenler yüklenemedi: ${esc(err.message)}</div>`;
  }
}

// Hesaplanan gozetmen tablosunu sinava yazar (degistiyse). Sinav gunu gecince
// bu kayit gosterilir. Gecmise satir yazilmaz; guncelleme damgasi degismez.
async function _gozetmenKaydiYaz(tarih, kaynak, oto, raporlu) {
  if (!duzenler() || !_sinav.id) return;
  const ilgili = new Set(Object.values(oto).map((o) => o.id));
  Object.values(_sinav.gozetmenler || {}).forEach((g) => ilgili.add(g.ogretmen_id));
  const yeni = { tarih, kaynak, oto, raporlu: [...raporlu].filter((id) => ilgili.has(id)).sort() };
  const k = _sinav.gozetmen_kayit;
  if (k && k.tarih === yeni.tarih && k.kaynak === yeni.kaynak
      && JSON.stringify(k.raporlu || []) === JSON.stringify(yeni.raporlu)
      && Object.keys(oto).length === Object.keys(k.oto || {}).length
      && Object.entries(oto).every(([a, o]) => k.oto?.[a]?.id === o.id && k.oto?.[a]?.ad === o.ad)) return;
  try {
    await setDoc(doc(db, "kelebek_sinavlar", _sinav.id), { gozetmen_kayit: yeni }, { mergeFields: ["gozetmen_kayit"] });
    _sinav.gozetmen_kayit = yeni;
  } catch (err) { /* sonraki acilista yeniden denenir */ }
}

let _gozetmenCanli = false;
window.kelebekGozetmenYenidenHesapla = () => { _gozetmenCanli = true; _gozetmenYukle(); };

function _gozetmenCiz(salonlar, kaynak, kayittan) {
  const el = document.getElementById("kbGozetmen");
  const ro = !duzenler();
  el.innerHTML = `<p style="font-size:13px;color:var(--text2);margin-bottom:8px;">Her ders saatinde o salonda (sınıfta) dersi olan öğretmen gözetmendir; öğretmen kendi dersinin başladığı saatte gelir. Kaynak: ${esc(kaynak)}. Okulda olmayan gözetmenin yerine "Değiştir" ile önce boş nöbetçi, yoksa diğer boş öğretmenlerden birini seçin.</p>
    ${kayittan ? `<div class="uyari-kutu-sm" style="background:#e8f0fe;">Sınav tarihi geçti: gözetmenler sınav için kaydedilmiş listeden gösteriliyor (program sonradan değişse de bu bilgi korunur).
      ${ro ? "" : '<button class="btn btn-gri btn-sm" style="margin-left:6px;" onclick="kelebekGozetmenYenidenHesapla()">Programdan yeniden hesapla</button>'}</div>` : ""}
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
    ${ro ? "" : '<p style="font-size:12px;color:var(--text2);margin-top:6px;">Gözetmen değişiklikleri otomatik kaydedilir ve geçmişe yazılır.</p>'}`;
  _bilgiCiz();
  if (_yoklama) _yoklamaCiz();
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

const _gozetmenYeri = (anahtar) => { const [salon, saat] = [anahtar.slice(0, anahtar.lastIndexOf("|")), anahtar.split("|").pop()]; return `${salon}, ${saat}. ders`; };

window.kelebekGozetmenSec = async (anahtar, sel) => {
  if (!sel.value) return;
  const ad = sel.options[sel.selectedIndex].text;
  const onceki = _gozetmen[anahtar]?.ad || "—";
  _sinav.gozetmenler = { ...(_sinav.gozetmenler || {}), [anahtar]: { ogretmen_id: sel.value, ad } };
  _gozetmenYukle();
  await _kaydetGoster("gozetmen", `${_gozetmenYeri(anahtar)}: ${onceki} yerine ${ad}`, false, "Gözetmen kaydedildi.");
};
window.kelebekGozetmenOtomatik = async (anahtar) => {
  const g = { ...(_sinav.gozetmenler || {}) };
  delete g[anahtar];
  _sinav.gozetmenler = g;
  _gozetmenYukle();
  await _kaydetGoster("gozetmen", `${_gozetmenYeri(anahtar)}: programdaki öğretmene geri dönüldü`, false, "Gözetmen kaydedildi.");
};

// ── Salon yoklaması ──
// Gozetmenler ogretmen ekranindan (portal-kelebek-ogretmen.js) girer; admin
// burada gorur, gerekirse kendisi girer/duzeltir.
let _yoklama = null;      // yoklamaId -> kayit (okununca)
let _yoklamaForm = null;  // acik form "salon|saat"

async function _yoklamaYukle() {
  const el = document.getElementById("kbYoklama");
  if (!el) return;
  if (!_sinav.id || !_sinav.dagilim.length || !_sinav.saatler.length) {
    el.innerHTML = '<div class="bos-mesaj">Dağıtım yapılıp ders saatleri seçilince gözetmenlerin girdiği salon yoklamaları burada görünür.</div>';
    return;
  }
  const sinav = _sinav;
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const k = await yoklamaOku(sinav.id);
    if (_sinav !== sinav) return;
    _yoklama = k;
    _yoklamaCiz();
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Yoklamalar okunamadı: ${esc(err.message)}</div>`;
  }
}

function _yoklamaCiz() {
  const el = document.getElementById("kbYoklama");
  if (!el || !_yoklama) return;
  const ro = !duzenler();
  const saatler = _sinav.saatler;
  el.innerHTML = `<p style="font-size:13px;color:var(--text2);margin-bottom:8px;">Her ders saatinin gözetmeni öğretmen ekranından (🦋 Kelebek Sınav) kendi saatinin yoklamasını sınav günü girer; sonraki saatlerin gözetmenleri değişiklik yoksa "aynı" diye onaylar.${ro ? "" : " Gerekirse buradan da girip düzeltebilirsiniz."}</p>
    <button class="btn btn-gri btn-sm" style="margin-bottom:8px;" onclick="kelebekYoklamaYenile()">🔄 Yenile</button>
    <div style="overflow-x:auto;"><table><thead><tr><th>Salon</th>${saatler.map((s) => `<th>${s}. ders</th>`).join("")}</tr></thead><tbody>
    ${_salonSirasi().map((salon) => `<tr><td><strong>${esc(salon)}</strong><div style="font-size:11px;color:var(--text2);">${_siraliSalon(salon).length} öğrenci</div></td>
      ${saatler.map((saat) => {
        const k = _yoklama.get(yoklamaId(salon, saat));
        const g = _gozetmen[salon + "|" + saat];
        return `<td style="vertical-align:top;min-width:170px;font-size:13px;">${yoklamaDurumHtml(k)}
          ${k?.yoklar?.length ? `<div style="font-size:12px;color:#ea4335;">${esc(yokMetni(k))}</div>` : ""}
          <div style="font-size:11px;color:var(--text2);">👁 ${g?.id ? esc(g.ad) : "—"}</div>
          ${ro ? "" : `<button class="btn btn-gri btn-sm" style="margin-top:4px;" data-s="${esc(salon)}" onclick="kelebekYoklamaAc(this.dataset.s, ${saat})">${k ? "Düzelt" : "Gir"}</button>`}</td>`;
      }).join("")}</tr>`).join("")}
    </tbody></table></div>
    <div id="kbYoklamaForm" style="margin-top:10px;"></div>`;
  if (!_yoklamaForm) return;
  const i = _yoklamaForm.lastIndexOf("|");
  const salon = _yoklamaForm.slice(0, i), saat = Number(_yoklamaForm.slice(i + 1));
  const kutu = document.getElementById("kbYoklamaForm");
  yoklamaFormuCiz(kutu, {
    sinav: _sinav, salon, saat, kayitlar: _yoklama,
    kim: { id: state.ogretmenDoc?.id || "", ad: state.kullanici?.ad || "" },
    onKaydet: (k) => { _yoklama.set(yoklamaId(salon, saat), k); _yoklamaForm = null; _yoklamaCiz(); mesajGoster("kbMesaj", `${salon} · ${saat}. ders yoklaması kaydedildi.`, "basari"); },
    onKapat: () => { _yoklamaForm = null; _yoklamaCiz(); },
  });
  kutu.scrollIntoView({ behavior: "smooth", block: "start" });
}

window.kelebekYoklamaAc = (salon, saat) => { _yoklamaForm = salon + "|" + saat; _yoklamaCiz(); };
window.kelebekYoklamaYenile = () => { _yoklamaForm = null; _yoklamaYukle(); };

// ── Sınav bilgisi (sinav sirasinda / sonrasinda hizli bakis) ──
// Sube sube, salon salon liste ve ogrenci arama. Idare de gorur.
let _bilgiSekme = "sube";
let _bilgiAcik = new Set();  // acik sube/salon kutulari
let _bilgiArama = "";

const _kucuk = (s) => String(s || "").toLocaleLowerCase("tr");

function _bilgiCiz() {
  const kart = document.getElementById("kbBilgiKart");
  const el = document.getElementById("kbBilgi");
  if (!kart || !el) return;
  const d = _sinav.dagilim;
  kart.hidden = !d.length;
  if (!d.length) return;
  const yedekSayi = d.filter((x) => x.yerine).length;
  const sekme = (id, ad) => `<button class="sekme-btn${_bilgiSekme === id ? " aktif" : ""}" onclick="kelebekBilgiSekme('${id}')">${ad}</button>`;
  el.innerHTML = `<div style="font-size:13px;color:var(--text2);margin-bottom:8px;">${esc(trTarih(_sinav.tarih))} · ${esc(saatMetni(_sinav.saatler))} ·
      <strong>${d.length}</strong> öğrenci · ${_salonSirasi().length} salon · ${new Set(d.map((x) => x.sinif)).size} şube${yedekSayi ? ` · ${yedekSayi} yedek` : ""}</div>
    <div class="sekme-bar" style="margin-bottom:10px;">${sekme("sube", "Şubeye göre")}${sekme("salon", "Salona göre")}${sekme("ara", "🔍 Öğrenci ara")}</div>
    <div id="kbBilgiIcerik"></div>`;
  const ic = document.getElementById("kbBilgiIcerik");
  if (_bilgiSekme === "ara") {
    ic.innerHTML = `<input id="kbBilgiAra" type="search" placeholder="Öğrenci adı ya da numarası" value="${esc(_bilgiArama)}" oninput="kelebekBilgiAra(this.value)" style="width:100%;max-width:360px;margin-bottom:8px;">
      <div id="kbBilgiSonuc"></div>`;
    _bilgiSonucCiz();
    return;
  }
  const siraVar = !!_sinav.sira_no;
  const yedekVar = yedekSayi > 0;
  const yedekTd = (x) => (yedekVar ? `<td style="color:#e65100;">${esc(x.yerine || "")}</td>` : "");
  const kutu = (anahtar, baslik, govde) => `<details class="kb-bilgi-kutu" data-k="${esc(anahtar)}" ${_bilgiAcik.has(anahtar) ? "open" : ""} ontoggle="kelebekBilgiKutu(this)">
    <summary>${baslik}</summary>${govde}</details>`;
  if (_bilgiSekme === "sube") {
    const subeler = [...new Set(d.map((x) => x.sinif))].sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
    ic.innerHTML = subeler.map((sube) => {
      const liste = d.filter((x) => x.sinif === sube).sort((a, b) => a.no.localeCompare(b.no, "tr", { numeric: true }));
      return kutu("sube|" + sube, `<strong>${esc(sube)}</strong> <span style="color:var(--text2);font-size:12px;">(${liste.length} öğrenci)</span>`,
        `<div style="overflow-x:auto;"><table><thead><tr><th>No</th><th>Ad Soyad</th><th>Salon</th>${siraVar ? "<th>Sıra</th>" : ""}${yedekVar ? "<th>Yerine Girecek</th>" : ""}</tr></thead><tbody>
        ${liste.map((x) => `<tr><td>${esc(x.no)}</td><td>${esc(x.ad)}</td><td><strong>${esc(x.salon)}</strong></td>${siraVar ? `<td>${x.sira ?? ""}</td>` : ""}${yedekTd(x)}</tr>`).join("")}
        </tbody></table></div>`);
    }).join("");
  } else {
    ic.innerHTML = _salonSirasi().map((salon) => {
      const liste = _siraliSalon(salon);
      return kutu("salon|" + salon, `<strong>${esc(salon)}</strong> <span style="color:var(--text2);font-size:12px;">(${liste.length} öğrenci)</span>`,
        `<div style="font-size:12px;margin:6px 0;">👁 ${_gozetmenMetni(salon).map(esc).join(" · ")}</div>
        <div style="overflow-x:auto;"><table><thead><tr><th>${siraVar ? "Sıra" : "#"}</th><th>No</th><th>Ad Soyad</th><th>Şube</th>${yedekVar ? "<th>Yerine Girecek</th>" : ""}</tr></thead><tbody>
        ${liste.map((x, i) => `<tr><td>${siraVar ? x.sira ?? "" : i + 1}</td><td>${esc(x.no)}</td><td>${esc(x.ad)}</td><td>${esc(x.sinif)}</td>${yedekTd(x)}</tr>`).join("")}
        </tbody></table></div>`);
    }).join("");
  }
}

function _bilgiSonucCiz() {
  const el = document.getElementById("kbBilgiSonuc");
  if (!el) return;
  const q = _kucuk(_bilgiArama.trim());
  if (!q) { el.innerHTML = '<div style="font-size:13px;color:var(--text2);">Ad, numara ya da yedek öğrenci adı yazın.</div>'; return; }
  const uyan = (ad, no, ek = "") => _kucuk(ad).includes(q) || String(no || "").startsWith(q) || (ek && _kucuk(ek).includes(q));
  const dagitimda = _sinav.dagilim.filter((x) => uyan(x.ad, x.no, x.yerine));
  const ids = new Set(_sinav.dagilim.map((x) => x.ogrenci_id));
  const disarida = _ogrenciler.filter((o) => !ids.has(o.ogrenci_id) && uyan(o.ad, o.no));
  const satirlar = [
    ...dagitimda.map((x) => `<div style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong>${esc(x.ad)}</strong> <span style="color:var(--text2);">(${esc(x.no)}, ${esc(x.sinif)})</span> → <strong>${esc(x.salon)}</strong>${x.sira != null ? `, sıra ${x.sira}` : ""}
      ${x.yerine ? `<div style="color:#e65100;font-size:13px;">🔁 Yerine girecek: <strong>${esc(x.yerine)}</strong></div>` : ""}
      <div style="font-size:12px;color:var(--text2);">👁 ${_gozetmenMetni(x.salon).map(esc).join(" · ")}</div></div>`),
    ...disarida.map((o) => `<div style="padding:6px 0;border-bottom:1px solid #eee;color:var(--text2);">
      ${esc(o.ad)} (${esc(o.no)}, ${esc(o.sinif)}) — ${_secili.has(o.ogrenci_id) ? "seçili ama dağıtıma eklenmemiş" : "bu sınava girmiyor"}</div>`),
  ];
  el.innerHTML = satirlar.length
    ? satirlar.slice(0, 50).join("") + (satirlar.length > 50 ? `<div style="font-size:12px;color:var(--text2);">… ${satirlar.length - 50} sonuç daha; aramayı daraltın.</div>` : "")
    : '<div class="bos-mesaj">Eşleşen öğrenci yok.</div>';
}

window.kelebekBilgiSekme = (s) => { _bilgiSekme = s; _bilgiCiz(); if (s === "ara") document.getElementById("kbBilgiAra")?.focus(); };
window.kelebekBilgiAra = (v) => { _bilgiArama = v; _bilgiSonucCiz(); };
window.kelebekBilgiKutu = (el) => { el.open ? _bilgiAcik.add(el.dataset.k) : _bilgiAcik.delete(el.dataset.k); };

// ── Çıktılar ──
function _ciktiCiz() {
  const el = document.getElementById("kbCikti");
  if (!el) return;
  if (!_sinav.dagilim.length) { el.innerHTML = '<div class="bos-mesaj">Önce dağıtım yapın.</div>'; return; }
  el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-mavi" onclick="kelebekYazdir('salon')">🖨 Salon kapı listeleri</button>
    <button class="btn btn-mavi" onclick="kelebekYazdir('sube')">🖨 Şube listeleri</button>
    <button class="btn btn-yesil" id="kbExcelBtn" onclick="kelebekExcel()">📊 Excel</button></div>`;
}

const _salonSirasi = () => salonSirasi(_gecerliSalonlar().map((s) => s.ad), _sinav.dagilim);
const _siraliSalon = (salon) => siraliSalon(_sinav.dagilim, salon);
const _gozetmenMetni = (salon) => _sinav.saatler.map((saat) => {
  const g = _gozetmen[salon + "|" + saat];
  return `${saat}. ders: ${g && g.id ? g.ad : "—"}`;
});

// Salondaki ogrencilerin seviyeye gore sayisi: "5E" -> 5. sinif; rakamla
// baslamayan subeler (ANA SINIF, HZİNA) kendi adiyla, sonda.
function _seviyeDagilimi(liste) {
  const say = {};
  liste.forEach((d) => {
    const sv = (String(d.sinif).match(/^\d+/) || [String(d.sinif)])[0];
    say[sv] = (say[sv] || 0) + 1;
  });
  return Object.entries(say)
    .sort(([a], [b]) => (/^\d/.test(b) - /^\d/.test(a)) || a.localeCompare(b, "tr", { numeric: true }))
    .map(([sv, n]) => `<strong>${/^\d+$/.test(sv) ? sv + ". sınıf" : esc(sv)}: ${n}</strong>`)
    .join(" · ");
}

function _baslikHtml(altBaslik) {
  return `<div class="kb-baslik"><div>${esc(_okulAd)}</div><div>${esc(_sinav.ad)}</div>
    <div style="font-weight:400;">${esc(trTarih(_sinav.tarih))} · ${esc(saatMetni(_sinav.saatler))}</div>
    <div class="kb-alt">${esc(altBaslik)}</div></div>`;
}

window.kelebekYazdir = (tur) => {
  const siraVar = !!_sinav.sira_no;
  const yedekVar = _sinav.dagilim.some((d) => d.yerine);
  const yTh = yedekVar ? "<th>Yerine Girecek</th>" : "";
  const yTd = (d) => (yedekVar ? `<td class="kb-sol">${esc(d.yerine || "")}</td>` : "");
  let html = "";
  if (tur === "salon") {
    html = _salonSirasi().map((salon) => {
      const liste = _siraliSalon(salon);
      return `<div class="kb-sayfa">${_baslikHtml("Salon: " + salon + " (" + liste.length + " öğrenci)")}
        <div class="kb-gozetmen">Gözetmenler: ${_gozetmenMetni(salon).map(esc).join(" · ")}</div>
        <table class="kb-tablo"><thead><tr>${siraVar ? "<th>Sıra</th>" : "<th>#</th>"}<th>No</th><th>Ad Soyad</th><th>Şube</th>${yTh}</tr></thead><tbody>
        ${liste.map((d, i) => `<tr><td>${siraVar ? d.sira : i + 1}</td><td>${esc(d.no)}</td><td class="kb-sol">${esc(d.ad)}</td><td>${esc(d.sinif)}</td>${yTd(d)}</tr>`).join("")}
        </tbody></table>
        <div class="kb-gozetmen" style="margin-top:8px;">Sınıf seviyelerine göre: ${_seviyeDagilimi(liste)} · Toplam: ${liste.length}</div></div>`;
    }).join("");
  } else {
    const subeler = [...new Set(_sinav.dagilim.map((d) => d.sinif))].sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
    html = subeler.map((sube) => {
      const liste = _sinav.dagilim.filter((d) => d.sinif === sube)
        .sort((a, b) => a.no.localeCompare(b.no, "tr", { numeric: true }));
      return `<div class="kb-sayfa">${_baslikHtml("Şube: " + sube + " (" + liste.length + " öğrenci)")}
        <table class="kb-tablo"><thead><tr><th>No</th><th>Ad Soyad</th><th>Salon</th>${siraVar ? "<th>Sıra</th>" : ""}${yTh}</tr></thead><tbody>
        ${liste.map((d) => `<tr><td>${esc(d.no)}</td><td class="kb-sol">${esc(d.ad)}</td><td>${esc(d.salon)}</td>${siraVar ? `<td>${d.sira}</td>` : ""}${yTd(d)}</tr>`).join("")}
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
    const yedekVar = _sinav.dagilim.some((d) => d.yerine);
    const y = (d) => (yedekVar ? [d.yerine || ""] : []);
    const yB = yedekVar ? ["Yerine Girecek"] : [];
    const yG = yedekVar ? [26] : [];
    const baslik = [[_okulAd], [_sinav.ad], [`${trTarih(_sinav.tarih)} · ${saatMetni(_sinav.saatler)}`], []];

    const tum = [...baslik, ["Salon", "Sıra", "No", "Ad Soyad", "Şube", ...yB]];
    _salonSirasi().forEach((salon) => _siraliSalon(salon).forEach((d, i) => tum.push([salon, siraVar ? d.sira : i + 1, d.no, d.ad, d.sinif, ...y(d)])));
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, tum, [20, 6, 8, 28, 8, ...yG]), sayfaAdi("Tüm Liste"));

    _salonSirasi().forEach((salon) => {
      const s = [...baslik, [`Salon: ${salon}`], ..._gozetmenMetni(salon).map((g) => ["Gözetmen", g]), [],
        [siraVar ? "Sıra" : "#", "No", "Ad Soyad", "Şube", ...yB],
        ..._siraliSalon(salon).map((d, i) => [siraVar ? d.sira : i + 1, d.no, d.ad, d.sinif, ...y(d)])];
      XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s, [10, 26, 28, 8, ...yG]), sayfaAdi(salon));
    });

    const sube = [...baslik, ["Şube", "No", "Ad Soyad", "Salon", "Sıra", ...yB],
      ..._sinav.dagilim.slice().sort((a, b) => a.sinif.localeCompare(b.sinif, "tr", { numeric: true }) || a.no.localeCompare(b.no, "tr", { numeric: true }))
        .map((d) => [d.sinif, d.no, d.ad, d.salon, siraVar ? d.sira : "", ...y(d)])];
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, sube, [8, 8, 28, 20, 6, ...yG]), sayfaAdi("Şubeler"));

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
