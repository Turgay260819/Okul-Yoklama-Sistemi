import { db, bugunHesapla, getDocs, collection } from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc } from "./portal-utils.js";
import {
  trTarih, saatMetni, sinavSalonlari, salonSirasi, siraliSalon, gozetmenHesapla,
  yoklamaOku, yoklamaId, yoklamaDurumHtml, yoklamaFormuCiz, yokMetni,
} from "./kelebek-ortak.js";

// ── KELEBEK SINAV (öğretmen) ──
// Adminin olusturdugu sinavlar salt okunur gosterilir: salona / subeye gore
// listeler, ogrenci arama. Ogretmen gozetmen oldugu salon+saat icin sinav
// gunu yoklama girer (kelebek-ortak.js yoklamaFormuCiz).

let _sinavlar = [];
let _sinav = null;
let _salonlar = [];       // sinavSalonlari(_sinav)
let _gozetmen = {};       // "salon|saat" -> { id, ad, ... }
let _yoklama = new Map();
let _form = null;         // acik yoklama formu "salon|saat"
let _yuklendi = false;    // gozetmen + yoklama okundu
let _sekme = "salon";
let _acik = new Set();    // acik salon/sube kutulari
let _arama = "";

const kok = () => document.getElementById("sayfa-kelebek-ogr");
const ogretmenAd = (id) => state.ogretmenler.find((o) => o.id === id)?.ad || "";
const benimId = () => state.ogretmenDoc?.id || "";
const _kucuk = (s) => String(s || "").toLocaleLowerCase("tr");

export async function kelebekOgretmenYukle() {
  kok().innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const snap = await getDocs(collection(db, "kelebek_sinavlar"));
    _sinavlar = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => !s.silindi && (s.dagilim || []).length)
      .sort((a, b) => (b.tarih || "").localeCompare(a.tarih || ""));
    if (!_sinavlar.length) { kok().innerHTML = '<div class="kart"><div class="bos-mesaj">Henüz yayınlanmış kelebek sınav yok.</div></div>'; return; }
    // Varsayilan: bugunku, yoksa en yakin gelecek, yoksa en son sinav.
    const bugun = bugunHesapla();
    const secili = _sinavlar.find((s) => s.id === _sinav?.id)
      || _sinavlar.find((s) => s.tarih === bugun)
      || _sinavlar.filter((s) => s.tarih > bugun).at(-1)
      || _sinavlar[0];
    await _sinavAc(secili.id);
  } catch (err) {
    kok().innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.kelebekOgretmenYukle = kelebekOgretmenYukle;

async function _sinavAc(id) {
  const sinav = _sinavlar.find((s) => s.id === id);
  if (!sinav) return;
  if (_sinav?.id !== id) { _acik = new Set(); _arama = ""; }
  _sinav = { saatler: [], gozetmenler: {}, ...sinav };
  _salonlar = sinavSalonlari(_sinav);
  _form = null;
  _gozetmen = {};
  _yoklama = new Map();
  _yuklendi = false;
  _ciz();
  try {
    const [g, y] = await Promise.all([
      gozetmenHesapla(_sinav, _salonlar, ogretmenAd, bugunHesapla()),
      yoklamaOku(id),
    ]);
    if (_sinav.id !== id) return;
    _gozetmen = g.tablo;
    _yoklama = y;
    _yuklendi = true;
  } catch (err) {
    document.getElementById("kboHata").textContent = "Gözetmen / yoklama bilgisi okunamadı: " + err.message;
  }
  _ciz();
}

window.kelebekOgrSinav = (id) => _sinavAc(id);
window.kelebekOgrYenile = () => kelebekOgretmenYukle();

const _salonSira = () => salonSirasi(_salonlar.map((s) => s.ad), _sinav.dagilim);
const _gozetmenSatiri = (salon) => _sinav.saatler.map((saat) => {
  const g = _gozetmen[salon + "|" + saat];
  return `${saat}. ders: ${g?.id ? g.ad : "—"}`;
}).join(" · ");

function _ciz() {
  const d = _sinav.dagilim;
  const sekme = (id, ad) => `<button class="sekme-btn${_sekme === id ? " aktif" : ""}" onclick="kelebekOgrSekme('${id}')">${ad}</button>`;
  kok().innerHTML = `
    <div class="kart">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <select onchange="kelebekOgrSinav(this.value)" style="flex:1;min-width:200px;">
          ${_sinavlar.map((s) => `<option value="${esc(s.id)}" ${s.id === _sinav.id ? "selected" : ""}>${esc(trTarih(s.tarih))} — ${esc(s.ad)}</option>`).join("")}
        </select>
        <button class="btn btn-gri btn-sm" onclick="kelebekOgrYenile()">🔄 Yenile</button></div>
      <div style="font-size:13px;color:var(--text2);margin-top:8px;">${esc(trTarih(_sinav.tarih))} · ${esc(saatMetni(_sinav.saatler))} ·
        <strong>${d.length}</strong> öğrenci · ${_salonSira().length} salon · ${new Set(d.map((x) => x.sinif)).size} şube</div>
      <div id="kboHata" style="color:#ea4335;font-size:13px;"></div>
    </div>
    <div class="kart"><div class="kart-baslik">👁 Gözetmenliklerim</div><div id="kboGorev"></div></div>
    <div class="kart">
      <div class="sekme-bar" style="margin-bottom:10px;">${sekme("salon", "Salona göre")}${sekme("sube", "Şubeye göre")}${sekme("ara", "🔍 Öğrenci ara")}</div>
      <div id="kboIcerik"></div></div>`;
  _gorevCiz();
  _icerikCiz();
}

// ── Gözetmenliklerim + yoklama ──
function _gorevCiz() {
  const el = document.getElementById("kboGorev");
  const benim = Object.entries(_gozetmen).filter(([, g]) => g.id && g.id === benimId()).map(([k]) => k)
    .sort((a, b) => Number(a.split("|").pop()) - Number(b.split("|").pop()));
  if (!benimId()) { el.innerHTML = '<div class="bos-mesaj">Öğretmen kaydınız bulunamadı.</div>'; return; }
  if (!_sinav.saatler.length) { el.innerHTML = '<div class="bos-mesaj">Bu sınavın ders saatleri henüz belirlenmemiş.</div>'; return; }
  if (!_yuklendi) { el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>'; return; }
  if (!benim.length) { el.innerHTML = '<div class="bos-mesaj">Bu sınavda gözetmenlik göreviniz yok.</div>'; return; }
  const sinavGunu = _sinav.tarih === bugunHesapla();
  el.innerHTML = `${sinavGunu ? "" : `<div style="font-size:13px;color:var(--text2);margin-bottom:8px;">Yoklama sınav günü (${esc(trTarih(_sinav.tarih))}) alınır.</div>`}
    ${benim.map((k) => {
      const i = k.lastIndexOf("|");
      const salon = k.slice(0, i), saat = Number(k.slice(i + 1));
      const kayit = _yoklama.get(yoklamaId(salon, saat));
      const baskasi = kayit && kayit.ogretmen_id !== benimId();
      return `<div class="kb-gorev">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <span style="flex:1;min-width:160px;"><strong>${esc(salon)}</strong> · ${saat}. ders <span style="font-size:12px;color:var(--text2);">(${siraliSalon(_sinav.dagilim, salon).length} öğrenci)</span></span>
          ${sinavGunu && !baskasi && _form !== k ? `<button class="btn ${kayit ? "btn-gri" : "btn-mavi"} btn-sm" data-k="${esc(k)}" onclick="kelebekOgrYoklama(this.dataset.k)">${kayit ? "✏️ Düzelt" : "📝 Yoklama al"}</button>` : ""}</div>
        <div style="font-size:13px;margin-top:4px;">${yoklamaDurumHtml(kayit)}</div>
        ${kayit?.yoklar?.length ? `<div style="font-size:12px;color:#ea4335;">Yok: ${esc(yokMetni(kayit))}</div>` : ""}
        <div class="kbo-form" data-k="${esc(k)}"></div></div>`;
    }).join("")}`;
  if (!_form) return;
  const kutu = [...el.querySelectorAll(".kbo-form")].find((e) => e.dataset.k === _form);
  if (!kutu) return;
  const i = _form.lastIndexOf("|");
  const salon = _form.slice(0, i), saat = Number(_form.slice(i + 1));
  yoklamaFormuCiz(kutu, {
    sinav: _sinav, salon, saat, kayitlar: _yoklama,
    kim: { id: benimId(), ad: state.ogretmenDoc?.ad || state.kullanici?.ad || "" },
    onKaydet: (kayit) => { _yoklama.set(yoklamaId(salon, saat), kayit); _form = null; _gorevCiz(); _icerikCiz(); },
    onKapat: () => { _form = null; _gorevCiz(); },
  });
  kutu.scrollIntoView({ behavior: "smooth", block: "start" });
}

window.kelebekOgrYoklama = (k) => { _form = k; _gorevCiz(); };

// ── Salona / şubeye göre, öğrenci ara ──
window.kelebekOgrSekme = (s) => { _sekme = s; _ciz(); if (s === "ara") document.getElementById("kboAra")?.focus(); };
window.kelebekOgrKutu = (el) => { el.open ? _acik.add(el.dataset.k) : _acik.delete(el.dataset.k); };
window.kelebekOgrAra = (v) => { _arama = v; _aramaCiz(); };

function _icerikCiz() {
  const ic = document.getElementById("kboIcerik");
  if (!ic) return;
  const d = _sinav.dagilim;
  if (_sekme === "ara") {
    ic.innerHTML = `<input id="kboAra" type="search" placeholder="Öğrenci adı ya da numarası" value="${esc(_arama)}" oninput="kelebekOgrAra(this.value)" style="width:100%;max-width:360px;margin-bottom:8px;">
      <div id="kboSonuc"></div>`;
    _aramaCiz();
    return;
  }
  const siraVar = !!_sinav.sira_no;
  const yedekVar = d.some((x) => x.yerine);
  const yedekTd = (x) => (yedekVar ? `<td style="color:#e65100;">${esc(x.yerine || "")}</td>` : "");
  const kutu = (anahtar, baslik, govde) => `<details class="kb-bilgi-kutu" data-k="${esc(anahtar)}" ${_acik.has(anahtar) ? "open" : ""} ontoggle="kelebekOgrKutu(this)">
    <summary>${baslik}</summary>${govde}</details>`;
  if (_sekme === "sube") {
    const subeler = [...new Set(d.map((x) => x.sinif))].sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
    ic.innerHTML = subeler.map((sube) => {
      const liste = d.filter((x) => x.sinif === sube).sort((a, b) => a.no.localeCompare(b.no, "tr", { numeric: true }));
      const salonSay = {};
      liste.forEach((x) => (salonSay[x.salon] = (salonSay[x.salon] || 0) + 1));
      return kutu("sube|" + sube, `<strong>${esc(sube)}</strong> <span style="color:var(--text2);font-size:12px;">(${liste.length} öğrenci)</span>`,
        `<div style="font-size:12px;margin:4px 0 6px;">🏫 ${Object.entries(salonSay).map(([s, n]) => `${esc(s)}: ${n}`).join(" · ")}</div>
        <div style="overflow-x:auto;"><table><thead><tr><th>No</th><th>Ad Soyad</th><th>Salon</th>${siraVar ? "<th>Sıra</th>" : ""}${yedekVar ? "<th>Yerine Girecek</th>" : ""}</tr></thead><tbody>
        ${liste.map((x) => `<tr><td>${esc(x.no)}</td><td>${esc(x.ad)}</td><td><strong>${esc(x.salon)}</strong></td>${siraVar ? `<td>${x.sira ?? ""}</td>` : ""}${yedekTd(x)}</tr>`).join("")}
        </tbody></table></div>`);
    }).join("");
    return;
  }
  ic.innerHTML = _salonSira().map((salon) => {
    const liste = siraliSalon(d, salon);
    const yoklamalar = _sinav.saatler.map((saat) => {
      const k = _yoklama.get(yoklamaId(salon, saat));
      return `<div>${saat}. ders: ${yoklamaDurumHtml(k)}${k?.yoklar?.length ? ` <span style="color:#ea4335;">— ${esc(yokMetni(k))}</span>` : ""}</div>`;
    }).join("");
    return kutu("salon|" + salon, `<strong>${esc(salon)}</strong> <span style="color:var(--text2);font-size:12px;">(${liste.length} öğrenci)</span>`,
      `<div style="font-size:12px;margin:6px 0;">👁 ${esc(_gozetmenSatiri(salon))}</div>
      <div style="font-size:12px;margin-bottom:6px;">${yoklamalar}</div>
      <div style="overflow-x:auto;"><table><thead><tr><th>${siraVar ? "Sıra" : "#"}</th><th>No</th><th>Ad Soyad</th><th>Şube</th>${yedekVar ? "<th>Yerine Girecek</th>" : ""}</tr></thead><tbody>
      ${liste.map((x, i) => `<tr><td>${siraVar ? x.sira ?? "" : i + 1}</td><td>${esc(x.no)}</td><td>${esc(x.ad)}</td><td>${esc(x.sinif)}</td>${yedekTd(x)}</tr>`).join("")}
      </tbody></table></div>`);
  }).join("");
}

function _aramaCiz() {
  const el = document.getElementById("kboSonuc");
  if (!el) return;
  const q = _kucuk(_arama.trim());
  if (!q) { el.innerHTML = '<div style="font-size:13px;color:var(--text2);">Ad, numara ya da yedek öğrenci adı yazın.</div>'; return; }
  const sonuc = _sinav.dagilim.filter((x) => _kucuk(x.ad).includes(q) || String(x.no || "").startsWith(q) || (x.yerine && _kucuk(x.yerine).includes(q)));
  el.innerHTML = sonuc.length
    ? sonuc.slice(0, 50).map((x) => `<div style="padding:6px 0;border-bottom:1px solid #eee;">
        <strong>${esc(x.ad)}</strong> <span style="color:var(--text2);">(${esc(x.no)}, ${esc(x.sinif)})</span> → <strong>${esc(x.salon)}</strong>${x.sira != null ? `, sıra ${x.sira}` : ""}
        ${x.yerine ? `<div style="color:#e65100;font-size:13px;">🔁 Yerine girecek: <strong>${esc(x.yerine)}</strong></div>` : ""}
        <div style="font-size:12px;color:var(--text2);">👁 ${esc(_gozetmenSatiri(x.salon))}</div></div>`).join("")
      + (sonuc.length > 50 ? `<div style="font-size:12px;color:var(--text2);">… ${sonuc.length - 50} sonuç daha; aramayı daraltın.</div>` : "")
    : '<div class="bos-mesaj">Bu sınavda eşleşen öğrenci yok.</div>';
}
