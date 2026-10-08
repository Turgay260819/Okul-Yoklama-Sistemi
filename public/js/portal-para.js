import {
  db, auth,
  getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";
import { xlsxYukle, sayfaOlustur, dosyaAdi } from "./portal-excel.js";

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

// ── Kademeye göre tutar seçenekleri ──
// para_toplamalar.tutarlar: [{ tutar, kademeler: ["5","6"] }] (en fazla 5).
// Kademe = sube adinin bastaki sayisi ("7-A" -> "7"). Secenegi olmayan
// kademelerde (ve eski toplamalarda) varsayilan_tutar kullanilir.
const TUTAR_SECENEK_SAYISI = 5;
const kademe = (sinif) => (String(sinif || "").match(/^\d+/) || [""])[0];

function kademeler() {
  return [...new Set(_ogrenciler.map((o) => kademe(o.class_id)).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
}

export function ogrenciTutari(t, sinif) {
  if (!t) return "";
  const k = kademe(sinif);
  const secenek = (t.tutarlar || []).find((s) => (s.kademeler || []).includes(k));
  if (secenek) return Number(secenek.tutar);
  return t.varsayilan_tutar ? Number(t.varsayilan_tutar) : "";
}

function tutarOzetleri(t) {
  const satirlar = (t.tutarlar || []).map((s) =>
    `${[...s.kademeler].sort((a, b) => Number(a) - Number(b)).join(", ")}. sınıflar: ${tl(s.tutar)}`);
  if (t.varsayilan_tutar) satirlar.push(`${satirlar.length ? "Diğer" : "Tüm"} sınıflar: ${tl(t.varsayilan_tutar)}`);
  return satirlar;
}

function _tutarBlokHtml(onek, t) {
  const ks = kademeler();
  const secenekler = t?.tutarlar || [];
  let html = `<div style="font-weight:700;margin:4px 0 6px;">Tutar seçenekleri <span style="font-weight:400;font-size:12px;color:var(--text2);">(en fazla ${TUTAR_SECENEK_SAYISI}; her tutarın hangi kademelere uygulanacağını işaretleyin, boş satırlar yok sayılır)</span></div>`;
  for (let i = 0; i < TUTAR_SECENEK_SAYISI; i++) {
    const s = secenekler[i] || { tutar: "", kademeler: [] };
    html += `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
      <input type="number" id="${onek}Tutar${i}" min="0" step="0.01" placeholder="${i + 1}. tutar (₺)" value="${s.tutar === "" ? "" : esc(s.tutar)}" style="width:140px;" />
      ${ks.map((k) => `<label style="display:flex;gap:3px;align-items:center;font-size:13px;">
        <input type="checkbox" class="${onek}K${i}" value="${esc(k)}" ${s.kademeler.includes(k) ? "checked" : ""} />${esc(k)}. sınıf</label>`).join("")}
    </div>`;
  }
  html += `<div class="form-group" style="max-width:260px;margin-top:4px;"><label>Seçeneği olmayan kademeler için tutar (isteğe bağlı)</label>
    <input type="number" id="${onek}Varsayilan" min="0" step="0.01" value="${t?.varsayilan_tutar ? esc(t.varsayilan_tutar) : ""}" /></div>`;
  return html;
}

// Formdaki secenekleri okur ve dogrular; hata varsa Error firlatir.
export function tutarlariDogrula(satirlar, varsayilan) {
  const tutarlar = [];
  const kullanilan = new Map();
  satirlar.forEach((s, i) => {
    const tutar = s.tutar === "" || s.tutar == null ? null : Number(s.tutar);
    const ks = s.kademeler || [];
    if (tutar == null && !ks.length) return;
    if (tutar == null || !(tutar > 0)) throw new Error(`${i + 1}. seçenek: kademe seçilmiş ama geçerli bir tutar girilmemiş.`);
    if (!ks.length) throw new Error(`${i + 1}. seçenek: tutar girilmiş ama kademe seçilmemiş.`);
    ks.forEach((k) => {
      if (kullanilan.has(k)) throw new Error(`${k}. sınıflar hem ${kullanilan.get(k)}. hem ${i + 1}. seçenekte; bir kademe tek seçenekte olabilir.`);
      kullanilan.set(k, i + 1);
    });
    tutarlar.push({ tutar, kademeler: ks });
  });
  const v = varsayilan === "" || varsayilan == null ? 0 : Number(varsayilan);
  if (v < 0) throw new Error("Tutar negatif olamaz.");
  return { tutarlar, varsayilan_tutar: v };
}

function _tutarlarOku(onek) {
  const satirlar = [];
  for (let i = 0; i < TUTAR_SECENEK_SAYISI; i++) {
    satirlar.push({
      tutar: document.getElementById(`${onek}Tutar${i}`).value,
      kademeler: [...document.querySelectorAll(`.${onek}K${i}:checked`)].map((c) => c.value),
    });
  }
  return tutarlariDogrula(satirlar, document.getElementById(`${onek}Varsayilan`).value);
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
      ${tutarOzetleri(t).length ? `<div><span class="para-ozet-etiket" style="display:block;">Tutarlar</span>${tutarOzetleri(t).map((s) => `<div style="font-weight:700;">${esc(s)}</div>`).join("")}</div>` : ""}
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
      ${t ? `<button class="btn btn-gri" onclick="paraTutarFormAc()">💰 Tutarlar</button>
             <button class="btn btn-gri" onclick="paraAktiflikDegistir()">${t.aktif === false ? "Aktif yap" : "Pasif yap"}</button>
             <button class="btn btn-kirmizi" onclick="paraToplamaSil()">Sil</button>` : ""}
    </div>
    ${t?.aciklama ? `<div style="font-size:13px;color:var(--text2);margin-top:8px;">${esc(t.aciklama)}</div>` : ""}
    <div id="paraYeniForm" hidden style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
      <div class="form-grid">
        <div class="form-group"><label>Ad</label><input type="text" id="paraYeniAd" maxlength="80" placeholder="Ör. Kermes 2026" /></div>
        <div class="form-group"><label>Açıklama</label><input type="text" id="paraYeniAciklama" maxlength="200" placeholder="İsteğe bağlı" /></div>
      </div>
      ${_tutarBlokHtml("paraYeni", null)}
      <button class="btn btn-yesil" onclick="paraToplamaOlustur()">Oluştur</button>
      <div class="mesaj" id="paraYeniMesaj" style="margin-top:8px;"></div>
    </div>
    ${t ? `<div id="paraTutarForm" hidden style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
      ${_tutarBlokHtml("paraDuz", t)}
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Değişiklik bundan sonra işaretlenen öğrencilere uygulanır; kayıtlı ödemelerin tutarı değişmez.</div>
      <button class="btn btn-yesil" onclick="paraTutarlarKaydet()">Kaydet</button>
      <div class="mesaj" id="paraTutarMesaj" style="margin-top:8px;"></div>
    </div>` : ""}
  </div>`;
}

window.paraTutarFormAc = () => {
  const f = document.getElementById("paraTutarForm");
  if (f) f.hidden = !f.hidden;
};

window.paraTutarlarKaydet = async () => {
  const t = secili();
  if (!t) return;
  let veri;
  try { veri = _tutarlarOku("paraDuz"); } catch (err) { mesajGoster("paraTutarMesaj", err.message, "hata"); return; }
  try {
    await updateDoc(doc(db, "para_toplamalar", t.id), veri);
    Object.assign(t, veri);
    _ciz();
    mesajGoster("paraMesaj", "Tutarlar kaydedildi.", "basari");
  } catch (err) {
    mesajGoster("paraTutarMesaj", "Hata: " + err.message, "hata");
  }
};

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
  const aciklama = document.getElementById("paraYeniAciklama").value.trim();
  if (!ad) { mesajGoster("paraYeniMesaj", "Ad zorunludur.", "hata"); return; }
  let tutarVeri;
  try { tutarVeri = _tutarlarOku("paraYeni"); } catch (err) { mesajGoster("paraYeniMesaj", err.message, "hata"); return; }
  try {
    const ref = await addDoc(collection(db, "para_toplamalar"), {
      ad, aciklama, ...tutarVeri, aktif: true,
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
      <td><input type="number" min="0" step="0.01" data-id="${esc(o.id)}" value="${od ? esc(od.tutar) : ""}" placeholder="${esc(ogrenciTutari(secili(), o.class_id))}" onchange="paraTutar(this)" style="width:110px;" /></td>
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
      const tutar = Number(tutarEl.value || ogrenciTutari(secili(), ogrenci.class_id) || 0);
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
    const birim = ogrenciTutari(secili(), s);
    return { sinif: s, mevcut, verenler, toplam, birim, beklenen: birim === "" ? null : birim * mevcut.length };
  });
  // Sinifi degismis/silinmis ogrencilerin odemeleri (kayittaki sinifa gore)
  const bilinenIdler = new Set(_ogrenciler.map((o) => o.id));
  const yetim = [..._odemeler.values()].filter((o) => !bilinenIdler.has(o.ogrenci_id));
  const genel = [..._odemeler.values()].reduce((t, o) => t + Number(o.tutar || 0), 0);
  const beklenenVar = satirlar.some((r) => r.beklenen != null);
  const genelBeklenen = satirlar.reduce((t, r) => t + (r.beklenen || 0), 0);

  let html = `<div class="para-yazdir-baslik">${esc(secili().ad)} — Sınıflara Göre</div>
    <div style="display:flex;justify-content:flex-end;margin:12px 0;">
      <button class="btn btn-gri btn-sm yazdirma-gizle" onclick="window.print()">🖨 Yazdır</button>
    </div>
    <div style="overflow-x:auto;"><table class="para-tablo"><thead><tr>
      <th>Sınıf</th><th style="text-align:center;">Veren / Mevcut</th>
      ${beklenenVar ? '<th style="text-align:right;">Kişi Başı</th><th style="text-align:right;">Beklenen</th>' : ""}
      <th style="text-align:right;">Toplanan</th><th class="yazdirma-gizle"></th>
    </tr></thead><tbody>`;
  const sutun = beklenenVar ? 6 : 4;
  const bos = beklenenVar ? "<td></td><td></td>" : "";
  satirlar.forEach((r) => {
    const acik = _acikSinif === r.sinif;
    html += `<tr class="${r.verenler.length ? "" : "para-bos-sinif"}">
      <td><strong>${esc(r.sinif)}</strong></td>
      <td style="text-align:center;">${r.verenler.length} / ${r.mevcut.length}</td>
      ${beklenenVar ? `<td style="text-align:right;">${r.birim === "" ? "—" : esc(tl(r.birim))}</td><td style="text-align:right;">${r.beklenen == null ? "—" : esc(tl(r.beklenen))}</td>` : ""}
      <td style="text-align:right;">${esc(tl(r.toplam))}</td>
      <td class="yazdirma-gizle" style="text-align:right;"><button class="btn btn-gri btn-sm" data-sinif="${esc(r.sinif)}" onclick="paraSinifAc(this)">${acik ? "Gizle" : "Ayrıntı"}</button></td>
    </tr>`;
    if (acik) {
      const vermeyen = r.mevcut.filter((o) => !_odemeler.has(o.id));
      html += `<tr><td colspan="${sutun}" style="background:#fafafa;">
        <div class="para-detay">
          <div><strong style="color:var(--yesil);">Verenler (${r.verenler.length})</strong>
            ${r.verenler.map((o) => `<div>${esc(o.student_number)} ${esc(o.name)} — ${esc(tl(_odemeler.get(o.id).tutar))}</div>`).join("") || '<div style="color:var(--text2);">—</div>'}</div>
          <div><strong style="color:var(--kirmizi);">Vermeyenler (${vermeyen.length})</strong>
            ${vermeyen.map((o) => `<div>${esc(o.student_number)} ${esc(o.name)}</div>`).join("") || '<div style="color:var(--text2);">—</div>'}</div>
        </div></td></tr>`;
    }
  });
  if (yetim.length) {
    html += `<tr><td>Diğer (kaydı değişmiş öğrenci)</td><td style="text-align:center;">${yetim.length}</td>${bos}
      <td style="text-align:right;">${esc(tl(yetim.reduce((t, o) => t + Number(o.tutar || 0), 0)))}</td><td class="yazdirma-gizle"></td></tr>`;
  }
  html += `<tr class="para-toplam"><td>Genel Toplam</td><td style="text-align:center;">${_odemeler.size} / ${_ogrenciler.length}</td>
    ${beklenenVar ? `<td></td><td style="text-align:right;">${esc(tl(genelBeklenen))}</td>` : ""}
    <td style="text-align:right;">${esc(tl(genel))}</td><td class="yazdirma-gizle"></td></tr>
    </tbody></table></div>`;
  return html;
}

window.paraSinifAc = (btn) => {
  _acikSinif = _acikSinif === btn.dataset.sinif ? null : btn.dataset.sinif;
  _sekmeCiz();
};

// ── Excel çıktısı ──
// Ortak yardimcilar portal-excel.js'te. Dosyada uc sayfa: Para Verenler,
// Siniflara Gore, Tum Ogrenciler (verdi/vermedi).
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
    const s2 = [["Sınıf", "Veren", "Mevcut", "Vermeyen", "Toplanan", "Kişi Başı", "Beklenen"]];
    let genelBeklenen = 0;
    siniflar().forEach((sf) => {
      const mevcut = _ogrenciler.filter((o) => o.class_id === sf);
      const veren = mevcut.filter((o) => _odemeler.has(o.id));
      const birim = ogrenciTutari(t, sf);
      if (birim !== "") genelBeklenen += birim * mevcut.length;
      s2.push([sf, veren.length, mevcut.length, mevcut.length - veren.length,
        veren.reduce((s, o) => s + num(_odemeler.get(o.id).tutar), 0),
        birim === "" ? "" : birim, birim === "" ? "" : birim * mevcut.length]);
    });
    const bilinen = new Set(_ogrenciler.map((o) => o.id));
    const yetim = [..._odemeler.values()].filter((o) => !bilinen.has(o.ogrenci_id));
    if (yetim.length) s2.push(["Diğer (kaydı değişmiş öğrenci)", yetim.length, "", "", yetim.reduce((s, o) => s + num(o.tutar), 0), "", ""]);
    s2.push([], ["Genel Toplam", _odemeler.size, _ogrenciler.length, "", toplam, "", genelBeklenen || ""]);
    const ozet = tutarOzetleri(t);
    if (ozet.length) s2.push([], ["Tutarlar"], ...ozet.map((x) => [x]));

    // 3) Tum ogrenciler
    const s3 = [["Sınıf", "No", "Ad Soyad", "Durum", "Tutar"]];
    _ogrenciler.forEach((o) => {
      const od = _odemeler.get(o.id);
      s3.push([o.class_id, Number(o.student_number) || o.student_number, o.name, od ? "Verdi" : "Vermedi", od ? num(od.tutar) : ""]);
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s1, [10, 8, 30, 14, 12], [3]), "Para Verenler");
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s2, [30, 8, 8, 10, 14, 12, 14], [4, 5, 6]), "Sınıflara Göre");
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s3, [10, 8, 30, 10, 14], [4]), "Tüm Öğrenciler");

    const bugun = new Date().toLocaleDateString("tr-TR").replace(/\./g, "-");
    const ad = dosyaAdi(t.ad) || "Para Toplama";
    XLSX.writeFile(wb, `${ad} - ${bugun}.xlsx`);
  } catch (err) {
    mesajGoster("paraMesaj", err.message, "hata");
  }
  btn.disabled = false;
  btn.textContent = eski;
};
