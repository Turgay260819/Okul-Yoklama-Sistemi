import {
  db, auth,
  getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── PARA TOPLAMA (admin) ──
// para_toplamalar: amac bazinda toplamalar (kermes, gezi...).
// para_odemeler/{toplamaId}_{ogrenciId}: ogrenci para verdiyse belge vardir;
// isaret kaldirilinca silinir. Ogrenci ad/no/sinif kayda kopyalanir ki ogrenci
// sonradan silinse ya da sinifi degisse de liste bozulmasin.

let _toplamalar = [];
let _seciliId = null;
let _ogrenciler = [];
let _odemeler = new Map();        // ogrenciId -> odeme
let _sekme = "giris";
let _sinifFiltre = "";
let _acikSinif = null;

const tl = (n) => Number(n || 0).toLocaleString("tr-TR", { style: "currency", currency: "TRY" });
const sinifSirala = (a, b) => String(a).localeCompare(String(b), "tr", { numeric: true });
const odemeId = (toplamaId, ogrenciId) => `${toplamaId}_${ogrenciId}`;

function secili() {
  return _toplamalar.find((t) => t.id === _seciliId) || null;
}

function siniflar() {
  const set = new Set(_ogrenciler.map((o) => o.class_id).filter(Boolean));
  return [...set].sort(sinifSirala);
}

export async function paraToplamaYukle() {
  const kok = document.getElementById("paraIcerik");
  if (!kok) return;
  kok.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const [tSnap, oSnap] = await Promise.all([
      getDocs(collection(db, "para_toplamalar")),
      getDocs(collection(db, "students")),
    ]);
    _toplamalar = [];
    tSnap.forEach((d) => _toplamalar.push({ id: d.id, ...d.data() }));
    _toplamalar.sort((a, b) => (b.aktif !== false) - (a.aktif !== false) || (b.olusturma?.toMillis?.() || 0) - (a.olusturma?.toMillis?.() || 0));
    _ogrenciler = [];
    oSnap.forEach((d) => {
      const v = d.data();
      _ogrenciler.push({ id: d.id, name: v.name || "", student_number: v.student_number ?? "", class_id: v.class_id || "" });
    });
    _ogrenciler.sort((a, b) => sinifSirala(a.class_id, b.class_id) || Number(a.student_number) - Number(b.student_number));
    if (!_seciliId || !secili()) _seciliId = _toplamalar[0]?.id || null;
    if (!_sinifFiltre) _sinifFiltre = siniflar()[0] || "";
    await _odemeleriYukle();
    _ciz();
  } catch (err) {
    kok.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.paraToplamaYukle = paraToplamaYukle;

async function _odemeleriYukle() {
  _odemeler = new Map();
  if (!_seciliId) return;
  const snap = await getDocs(query(collection(db, "para_odemeler"), where("toplama_id", "==", _seciliId)));
  snap.forEach((d) => _odemeler.set(d.data().ogrenci_id, { id: d.id, ...d.data() }));
}

function _ciz() {
  const kok = document.getElementById("paraIcerik");
  const t = secili();
  let html = _toplamaSecimHtml(t);
  if (!t) {
    html += '<div class="kart"><div class="bos-mesaj">Henüz para toplama yok. Yukarıdan "+ Yeni Toplama" ile başlayın.</div></div>';
    kok.innerHTML = html;
    return;
  }
  const toplamTutar = [..._odemeler.values()].reduce((s, o) => s + Number(o.tutar || 0), 0);
  html += `<div class="kart">
    <div class="para-ozet">
      <div><span class="para-ozet-sayi" id="paraOzetVeren">${_odemeler.size}</span><span class="para-ozet-etiket">Para veren / ${_ogrenciler.length} öğrenci</span></div>
      <div><span class="para-ozet-sayi" id="paraOzetToplam">${esc(tl(toplamTutar))}</span><span class="para-ozet-etiket">Toplanan</span></div>
      ${t.varsayilan_tutar ? `<div><span class="para-ozet-sayi">${esc(tl(t.varsayilan_tutar))}</span><span class="para-ozet-etiket">Varsayılan tutar</span></div>` : ""}
    </div>
    <div class="yazdirma-gizle" style="margin-top:10px;">
      <button class="btn btn-yesil btn-sm" id="paraExcelBtn" onclick="paraExcel()">📊 Excel'e aktar</button>
    </div>
    <div class="sekme-bar yazdirma-gizle" style="margin-top:12px;">
      <button class="sekme-btn${_sekme === "giris" ? " aktif" : ""}" onclick="paraSekme('giris')">Öğrenci Listesi</button>
      <button class="sekme-btn${_sekme === "verenler" ? " aktif" : ""}" onclick="paraSekme('verenler')">Para Verenler</button>
      <button class="sekme-btn${_sekme === "siniflar" ? " aktif" : ""}" onclick="paraSekme('siniflar')">Sınıflara Göre</button>
    </div>
    <div class="mesaj" id="paraMesaj"></div>
    <div id="paraSekmeIcerik"></div>
  </div>`;
  kok.innerHTML = html;
  _sekmeCiz();
}

function _toplamaSecimHtml(t) {
  const secenekler = _toplamalar.map((x) =>
    `<option value="${esc(x.id)}"${x.id === _seciliId ? " selected" : ""}>${esc(x.ad)}${x.aktif === false ? " (pasif)" : ""}</option>`).join("");
  return `<div class="kart yazdirma-gizle">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
      <div class="form-group" style="flex:1;min-width:200px;margin-bottom:0;">
        <label>Para Toplama</label>
        <select id="paraToplamaSec" onchange="paraToplamaSecildi(this.value)">${secenekler || '<option value="">—</option>'}</select>
      </div>
      <button class="btn btn-mavi" onclick="paraYeniFormAc()">+ Yeni Toplama</button>
      ${t ? `<button class="btn btn-gri" onclick="paraAktiflikDegistir()">${t.aktif === false ? "Aktif yap" : "Pasif yap"}</button>
             <button class="btn btn-kirmizi" onclick="paraToplamaSil()">Sil</button>` : ""}
    </div>
    ${t?.aciklama ? `<div style="font-size:13px;color:var(--text2);margin-top:8px;">${esc(t.aciklama)}</div>` : ""}
    <div id="paraYeniForm" hidden style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
      <div class="form-grid">
        <div class="form-group"><label>Ad</label><input type="text" id="paraYeniAd" maxlength="80" placeholder="Ör. Kermes 2026" /></div>
        <div class="form-group"><label>Varsayılan tutar (₺)</label><input type="number" id="paraYeniTutar" min="0" step="0.01" placeholder="Ör. 100" /></div>
        <div class="form-group"><label>Açıklama</label><input type="text" id="paraYeniAciklama" maxlength="200" placeholder="İsteğe bağlı" /></div>
      </div>
      <button class="btn btn-yesil" onclick="paraToplamaOlustur()">Oluştur</button>
      <div class="mesaj" id="paraYeniMesaj" style="margin-top:8px;"></div>
    </div>
  </div>`;
}

window.paraToplamaSecildi = async (id) => {
  _seciliId = id || null;
  _acikSinif = null;
  await _odemeleriYukle();
  _ciz();
};

window.paraSekme = (s) => { _sekme = s; _ciz(); };

window.paraYeniFormAc = () => {
  const f = document.getElementById("paraYeniForm");
  f.hidden = !f.hidden;
  if (!f.hidden) document.getElementById("paraYeniAd").focus();
};

window.paraToplamaOlustur = async () => {
  const ad = document.getElementById("paraYeniAd").value.trim();
  const tutar = Number(document.getElementById("paraYeniTutar").value || 0);
  const aciklama = document.getElementById("paraYeniAciklama").value.trim();
  if (!ad) { mesajGoster("paraYeniMesaj", "Ad zorunludur.", "hata"); return; }
  if (tutar < 0) { mesajGoster("paraYeniMesaj", "Tutar negatif olamaz.", "hata"); return; }
  try {
    const ref = await addDoc(collection(db, "para_toplamalar"), {
      ad, aciklama, varsayilan_tutar: tutar, aktif: true,
      olusturma: serverTimestamp(), olusturan_ad: state.kullanici?.ad || "",
    });
    _seciliId = ref.id;
    _sekme = "giris";
    await paraToplamaYukle();
  } catch (err) {
    mesajGoster("paraYeniMesaj", "Hata: " + err.message, "hata");
  }
};

window.paraAktiflikDegistir = async () => {
  const t = secili();
  if (!t) return;
  try {
    await updateDoc(doc(db, "para_toplamalar", t.id), { aktif: t.aktif === false });
    await paraToplamaYukle();
  } catch (err) {
    mesajGoster("paraMesaj", "Hata: " + err.message, "hata");
  }
};

window.paraToplamaSil = async () => {
  const t = secili();
  if (!t) return;
  const n = _odemeler.size;
  if (!await sor("Toplamayı Sil", `"${t.ad}" silinecek${n ? ` ve ${n} ödeme kaydı da silinecek` : ""}. Bu işlem geri alınamaz.`, "Sil", "btn-kirmizi")) return;
  try {
    const idler = [..._odemeler.values()].map((o) => o.id);
    for (let i = 0; i < idler.length; i += 20) {
      await Promise.all(idler.slice(i, i + 20).map((id) => deleteDoc(doc(db, "para_odemeler", id))));
    }
    await deleteDoc(doc(db, "para_toplamalar", t.id));
    _seciliId = null;
    await paraToplamaYukle();
  } catch (err) {
    mesajGoster("paraMesaj", "Hata: " + err.message, "hata");
  }
};

function _sekmeCiz() {
  const el = document.getElementById("paraSekmeIcerik");
  if (!el) return;
  if (_sekme === "giris") el.innerHTML = _girisHtml();
  else if (_sekme === "verenler") el.innerHTML = _verenlerHtml();
  else el.innerHTML = _siniflarHtml();
}

// ── Öğrenci listesi (giriş) ──
function _girisHtml() {
  const t = secili();
  const sinifSec = ['<option value="*">Tüm sınıflar</option>', ...siniflar().map((s) =>
    `<option value="${esc(s)}"${s === _sinifFiltre ? " selected" : ""}>${esc(s)}</option>`)].join("");
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">
      <select id="paraSinifSec" onchange="paraSinifFiltre(this.value)" style="max-width:180px;">${sinifSec}</select>
      <input type="text" id="paraAra" placeholder="Ad veya numara ara..." oninput="paraListeCiz()" style="flex:1;min-width:180px;" />
    </div>
    ${t.aktif === false ? '<div class="mesaj mesaj-bilgi" style="display:block;margin-bottom:8px;">Bu toplama pasif; yine de düzenleyebilirsiniz.</div>' : ""}
    <div style="overflow-x:auto;"><table class="para-tablo"><thead><tr>
      <th>No</th><th>Ad Soyad</th><th>Sınıf</th><th style="text-align:center;">Verdi</th><th>Tutar (₺)</th><th></th>
    </tr></thead><tbody id="paraListeGovde">${_girisSatirlari()}</tbody></table></div>`;
}

function _girisSatirlari() {
  const q = (document.getElementById("paraAra")?.value || "").trim().toLocaleLowerCase("tr");
  const liste = _ogrenciler.filter((o) =>
    (_sinifFiltre === "*" || o.class_id === _sinifFiltre) &&
    (!q || o.name.toLocaleLowerCase("tr").includes(q) || String(o.student_number).includes(q)));
  if (!liste.length) return '<tr><td colspan="6"><div class="bos-mesaj">Öğrenci bulunamadı.</div></td></tr>';
  return liste.map((o) => {
    const od = _odemeler.get(o.id);
    return `<tr class="${od ? "para-verdi" : ""}">
      <td>${esc(o.student_number)}</td>
      <td>${esc(o.name)}</td>
      <td>${esc(o.class_id)}</td>
      <td style="text-align:center;"><input type="checkbox" data-id="${esc(o.id)}" ${od ? "checked" : ""} onchange="paraIsaret(this)" style="width:20px;height:20px;" /></td>
      <td><input type="number" min="0" step="0.01" data-id="${esc(o.id)}" value="${od ? esc(od.tutar) : ""}" placeholder="${esc(secili()?.varsayilan_tutar || "")}" onchange="paraTutar(this)" style="width:110px;" /></td>
      <td id="paraDurum_${esc(o.id)}" style="font-size:12px;color:var(--yesil);white-space:nowrap;"></td>
    </tr>`;
  }).join("");
}

window.paraSinifFiltre = (s) => { _sinifFiltre = s; window.paraListeCiz(); };
window.paraListeCiz = () => {
  const g = document.getElementById("paraListeGovde");
  if (g) g.innerHTML = _girisSatirlari();
};

function _durum(ogrenciId, metin, hata = false) {
  const el = document.getElementById("paraDurum_" + ogrenciId);
  if (!el) return;
  el.textContent = metin;
  el.style.color = hata ? "var(--kirmizi)" : "var(--yesil)";
  if (!hata) setTimeout(() => { if (el.textContent === metin) el.textContent = ""; }, 2000);
}

async function _odemeYaz(ogrenci, tutar) {
  const t = secili();
  const id = odemeId(t.id, ogrenci.id);
  const veri = {
    toplama_id: t.id, ogrenci_id: ogrenci.id,
    ogrenci_ad: ogrenci.name, ogrenci_no: ogrenci.student_number, sinif: ogrenci.class_id,
    tutar, tarih: serverTimestamp(), kaydeden_uid: auth.currentUser?.uid || null,
  };
  await setDoc(doc(db, "para_odemeler", id), veri);
  _odemeler.set(ogrenci.id, { id, ...veri, tarih: null });
}

// Sadece ozet sayilarini ve ilgili satiri gunceller; tum listeyi yeniden
// cizmez ki Tab ile sonraki tutar alanina gecis ve "✓" durumu korunsun.
function _ozetGuncelle(ogrenciId) {
  const toplam = [..._odemeler.values()].reduce((t, o) => t + Number(o.tutar || 0), 0);
  const v = document.getElementById("paraOzetVeren");
  const tp = document.getElementById("paraOzetToplam");
  if (v) v.textContent = _odemeler.size;
  if (tp) tp.textContent = tl(toplam);
  const cb = document.querySelector(`#paraListeGovde input[type="checkbox"][data-id="${CSS.escape(ogrenciId)}"]`);
  if (!cb) return;
  const od = _odemeler.get(ogrenciId);
  cb.checked = !!od;
  cb.disabled = false;
  cb.closest("tr").classList.toggle("para-verdi", !!od);
  const tutarEl = cb.closest("tr").querySelector('input[type="number"]');
  if (od && document.activeElement !== tutarEl) tutarEl.value = od.tutar;
  if (!od) tutarEl.value = "";
}

window.paraIsaret = async (cb) => {
  const ogrenci = _ogrenciler.find((o) => o.id === cb.dataset.id);
  if (!ogrenci) return;
  const tutarEl = cb.closest("tr").querySelector('input[type="number"]');
  cb.disabled = true;
  try {
    if (cb.checked) {
      const tutar = Number(tutarEl.value || secili()?.varsayilan_tutar || 0);
      await _odemeYaz(ogrenci, tutar);
    } else {
      await deleteDoc(doc(db, "para_odemeler", odemeId(_seciliId, ogrenci.id)));
      _odemeler.delete(ogrenci.id);
    }
    _ozetGuncelle(ogrenci.id);
    _durum(ogrenci.id, "✓ kaydedildi");
  } catch (err) {
    cb.checked = !cb.checked;
    cb.disabled = false;
    _durum(ogrenci.id, "Kaydedilemedi", true);
    mesajGoster("paraMesaj", "Hata: " + err.message, "hata");
  }
};

// Tutar girilince ogrenci otomatik "verdi" isaretlenir; tutar silinirse
// isaret kalir (0 ₺ olarak) — kaldirmak icin kutudan isareti kaldirin.
window.paraTutar = async (input) => {
  const ogrenci = _ogrenciler.find((o) => o.id === input.dataset.id);
  if (!ogrenci) return;
  const tutar = Number(input.value || 0);
  if (tutar < 0) { _durum(ogrenci.id, "Negatif olamaz", true); return; }
  if (!_odemeler.has(ogrenci.id) && !input.value) return;
  try {
    await _odemeYaz(ogrenci, tutar);
    _ozetGuncelle(ogrenci.id);
    _durum(ogrenci.id, "✓ kaydedildi");
  } catch (err) {
    _durum(ogrenci.id, "Kaydedilemedi", true);
    mesajGoster("paraMesaj", "Hata: " + err.message, "hata");
  }
};

// ── Para verenler ──
function _verenlerHtml() {
  const liste = [..._odemeler.values()].sort((a, b) => sinifSirala(a.sinif, b.sinif) || Number(a.ogrenci_no) - Number(b.ogrenci_no));
  const toplam = liste.reduce((s, o) => s + Number(o.tutar || 0), 0);
  const baslik = `<div class="para-yazdir-baslik">${esc(secili().ad)} — Para Verenler</div>`;
  if (!liste.length) return baslik + '<div class="bos-mesaj">Henüz para veren yok.</div>';
  return `${baslik}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0;">
      <strong>${liste.length} öğrenci · ${esc(tl(toplam))}</strong>
      <button class="btn btn-gri btn-sm yazdirma-gizle" onclick="window.print()">🖨 Yazdır</button>
    </div>
    <div style="overflow-x:auto;"><table class="para-tablo"><thead><tr>
      <th>Sınıf</th><th>No</th><th>Ad Soyad</th><th style="text-align:right;">Tutar</th><th>Tarih</th>
    </tr></thead><tbody>
    ${liste.map((o) => `<tr>
      <td>${esc(o.sinif)}</td><td>${esc(o.ogrenci_no)}</td><td>${esc(o.ogrenci_ad)}</td>
      <td style="text-align:right;">${esc(tl(o.tutar))}</td>
      <td style="font-size:12px;color:var(--text2);">${o.tarih?.toDate ? esc(o.tarih.toDate().toLocaleDateString("tr-TR")) : ""}</td>
    </tr>`).join("")}
    <tr class="para-toplam"><td colspan="3">Toplam</td><td style="text-align:right;">${esc(tl(toplam))}</td><td></td></tr>
    </tbody></table></div>`;
}

// ── Sınıflara göre ──
function _siniflarHtml() {
  const satirlar = siniflar().map((s) => {
    const mevcut = _ogrenciler.filter((o) => o.class_id === s);
    const verenler = mevcut.filter((o) => _odemeler.has(o.id));
    const toplam = verenler.reduce((t, o) => t + Number(_odemeler.get(o.id).tutar || 0), 0);
    return { sinif: s, mevcut, verenler, toplam };
  });
  // Sinifi degismis/silinmis ogrencilerin odemeleri (kayittaki sinifa gore)
  const bilinenIdler = new Set(_ogrenciler.map((o) => o.id));
  const yetim = [..._odemeler.values()].filter((o) => !bilinenIdler.has(o.ogrenci_id));
  const genel = [..._odemeler.values()].reduce((t, o) => t + Number(o.tutar || 0), 0);

  let html = `<div class="para-yazdir-baslik">${esc(secili().ad)} — Sınıflara Göre</div>
    <div style="display:flex;justify-content:flex-end;margin:12px 0;">
      <button class="btn btn-gri btn-sm yazdirma-gizle" onclick="window.print()">🖨 Yazdır</button>
    </div>
    <div style="overflow-x:auto;"><table class="para-tablo"><thead><tr>
      <th>Sınıf</th><th style="text-align:center;">Veren / Mevcut</th><th style="text-align:right;">Toplam</th><th class="yazdirma-gizle"></th>
    </tr></thead><tbody>`;
  satirlar.forEach((r) => {
    const acik = _acikSinif === r.sinif;
    html += `<tr class="${r.verenler.length ? "" : "para-bos-sinif"}">
      <td><strong>${esc(r.sinif)}</strong></td>
      <td style="text-align:center;">${r.verenler.length} / ${r.mevcut.length}</td>
      <td style="text-align:right;">${esc(tl(r.toplam))}</td>
      <td class="yazdirma-gizle" style="text-align:right;"><button class="btn btn-gri btn-sm" data-sinif="${esc(r.sinif)}" onclick="paraSinifAc(this)">${acik ? "Gizle" : "Ayrıntı"}</button></td>
    </tr>`;
    if (acik) {
      const vermeyen = r.mevcut.filter((o) => !_odemeler.has(o.id));
      html += `<tr><td colspan="4" style="background:#fafafa;">
        <div class="para-detay">
          <div><strong style="color:var(--yesil);">Verenler (${r.verenler.length})</strong>
            ${r.verenler.map((o) => `<div>${esc(o.student_number)} ${esc(o.name)} — ${esc(tl(_odemeler.get(o.id).tutar))}</div>`).join("") || '<div style="color:var(--text2);">—</div>'}</div>
          <div><strong style="color:var(--kirmizi);">Vermeyenler (${vermeyen.length})</strong>
            ${vermeyen.map((o) => `<div>${esc(o.student_number)} ${esc(o.name)}</div>`).join("") || '<div style="color:var(--text2);">—</div>'}</div>
        </div></td></tr>`;
    }
  });
  if (yetim.length) {
    html += `<tr><td>Diğer (kaydı değişmiş öğrenci)</td><td style="text-align:center;">${yetim.length}</td>
      <td style="text-align:right;">${esc(tl(yetim.reduce((t, o) => t + Number(o.tutar || 0), 0)))}</td><td class="yazdirma-gizle"></td></tr>`;
  }
  html += `<tr class="para-toplam"><td>Genel Toplam</td><td style="text-align:center;">${_odemeler.size} / ${_ogrenciler.length}</td>
    <td style="text-align:right;">${esc(tl(genel))}</td><td class="yazdirma-gizle"></td></tr>
    </tbody></table></div>`;
  return html;
}

window.paraSinifAc = (btn) => {
  _acikSinif = _acikSinif === btn.dataset.sinif ? null : btn.dataset.sinif;
  _sekmeCiz();
};

// ── Excel çıktısı ──
// SheetJS sadece butona basilinca yuklenir (CSP: cdnjs izinli). Dosyada uc
// sayfa: Para Verenler, Siniflara Gore, Tum Ogrenciler (verdi/vermedi).
const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

function xlsxYukle() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = XLSX_URL;
    sc.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("Excel kütüphanesi yüklenemedi.")));
    sc.onerror = () => reject(new Error("Excel kütüphanesi yüklenemedi (internet bağlantısını kontrol edin)."));
    document.head.appendChild(sc);
  });
}

function sayfaOlustur(XLSX, satirlar, genislikler, tutarSutunlari) {
  const ws = XLSX.utils.aoa_to_sheet(satirlar);
  ws["!cols"] = genislikler.map((w) => ({ wch: w }));
  const aralik = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 1; r <= aralik.e.r; r++) {
    tutarSutunlari.forEach((c) => {
      const h = ws[XLSX.utils.encode_cell({ r, c })];
      if (h && typeof h.v === "number") h.z = '#,##0.00 "₺"';
    });
  }
  return ws;
}

window.paraExcel = async () => {
  const t = secili();
  if (!t) return;
  const btn = document.getElementById("paraExcelBtn");
  const eski = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Hazırlanıyor...";
  try {
    const XLSX = await xlsxYukle();
    const num = (n) => Number(n || 0);
    const noSirala = (a, b) => Number(a) - Number(b);

    // 1) Para verenler
    const verenler = [..._odemeler.values()].sort((a, b) => sinifSirala(a.sinif, b.sinif) || noSirala(a.ogrenci_no, b.ogrenci_no));
    const toplam = verenler.reduce((s, o) => s + num(o.tutar), 0);
    const s1 = [["Sınıf", "No", "Ad Soyad", "Tutar", "Tarih"]];
    verenler.forEach((o) => s1.push([o.sinif, Number(o.ogrenci_no) || o.ogrenci_no, o.ogrenci_ad, num(o.tutar),
      o.tarih?.toDate ? o.tarih.toDate().toLocaleDateString("tr-TR") : ""]));
    s1.push([], ["", "", `Toplam (${verenler.length} öğrenci)`, toplam, ""]);

    // 2) Siniflara gore
    const s2 = [["Sınıf", "Veren", "Mevcut", "Vermeyen", "Toplam"]];
    siniflar().forEach((sf) => {
      const mevcut = _ogrenciler.filter((o) => o.class_id === sf);
      const veren = mevcut.filter((o) => _odemeler.has(o.id));
      s2.push([sf, veren.length, mevcut.length, mevcut.length - veren.length,
        veren.reduce((s, o) => s + num(_odemeler.get(o.id).tutar), 0)]);
    });
    const bilinen = new Set(_ogrenciler.map((o) => o.id));
    const yetim = [..._odemeler.values()].filter((o) => !bilinen.has(o.ogrenci_id));
    if (yetim.length) s2.push(["Diğer (kaydı değişmiş öğrenci)", yetim.length, "", "", yetim.reduce((s, o) => s + num(o.tutar), 0)]);
    s2.push([], ["Genel Toplam", _odemeler.size, _ogrenciler.length, "", toplam]);

    // 3) Tum ogrenciler
    const s3 = [["Sınıf", "No", "Ad Soyad", "Durum", "Tutar"]];
    _ogrenciler.forEach((o) => {
      const od = _odemeler.get(o.id);
      s3.push([o.class_id, Number(o.student_number) || o.student_number, o.name, od ? "Verdi" : "Vermedi", od ? num(od.tutar) : ""]);
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s1, [10, 8, 30, 14, 12], [3]), "Para Verenler");
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s2, [30, 8, 8, 10, 14], [4]), "Sınıflara Göre");
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s3, [10, 8, 30, 10, 14], [4]), "Tüm Öğrenciler");

    const bugun = new Date().toLocaleDateString("tr-TR").replace(/\./g, "-");
    const ad = String(t.ad).replace(/[\/:*?"<>|]/g, "-").trim() || "Para Toplama";
    XLSX.writeFile(wb, `${ad} - ${bugun}.xlsx`);
  } catch (err) {
    mesajGoster("paraMesaj", err.message, "hata");
  }
  btn.disabled = false;
  btn.textContent = eski;
};
