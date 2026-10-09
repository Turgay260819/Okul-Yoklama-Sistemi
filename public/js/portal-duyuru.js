import {
  db, auth, functions, httpsCallable,
  getDocs, addDoc, updateDoc, deleteDoc, doc, collection, query, where, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── BİLDİRİM GÖNDER (admin) ──
// Hedef (tum ogretmenler / zumre / secili) burada ogretmen id'lerine cozulur;
// idareMesajiGonder bunlari dogrulayip zile ve telefona gonderir, arsivler.

let _hedefTip = "hepsi";
const _seciliZumreler = new Set();
const _seciliOgretmenler = new Set();
const _seciliSiniflar = new Set();   // "Sinif duzeyi" hedefi (anlik)
const _zamanliSiniflar = new Set();  // zamanli bildirim formu
let _programOgretmenleri = {};       // sinif adi -> Set(ogretmen id), haftalik programdan

const kademe = (s) => (String(s || "").match(/^\d+/) || [""])[0];
const siniflarSirali = () => state.siniflar.map((s) => s.class_name).filter(Boolean)
  .sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));

async function _programYukle() {
  _programOgretmenleri = {};
  const snap = await getDocs(collection(db, "schedule"));
  snap.forEach((d) => {
    const v = d.data();
    if (v.class_id && v.teacher_id) (_programOgretmenleri[v.class_id] ||= new Set()).add(v.teacher_id);
  });
}

// Sube secim cipleri, kademeye gore; kademe dugmesi o kademenin tum
// subelerini secer/kaldirir. `ad`: secimi tutan Set'in adi ("anlik"|"zamanli").
function _sinifSecimHtml(set, ad) {
  const gruplar = {};
  siniflarSirali().forEach((s) => (gruplar[kademe(s) || "Diğer"] ||= []).push(s));
  return Object.entries(gruplar).map(([k, liste]) => {
    const hepsi = liste.every((s) => set.has(s));
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
      <button type="button" class="duyuru-chip${hepsi ? " secili" : ""}" data-k="${esc(k)}" data-ad="${ad}" onclick="duyuruKademe(this)"><strong>${esc(k)}. sınıflar</strong></button>
      ${liste.map((s) => `<button type="button" class="duyuru-chip${set.has(s) ? " secili" : ""}" data-s="${esc(s)}" data-ad="${ad}" onclick="duyuruSinif(this)">${esc(s)}</button>`).join("")}
    </div>`;
  }).join("");
}

const _sinifSet = (ad) => (ad === "zamanli" ? _zamanliSiniflar : _seciliSiniflar);

function _sinifOzet(set) {
  const liste = [...set].sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
  const kademeler = [...new Set(siniflarSirali().map(kademe))]
    .filter((k) => { const s = siniflarSirali().filter((x) => kademe(x) === k); return s.length && s.every((x) => set.has(x)); });
  const tekil = liste.filter((s) => !kademeler.includes(kademe(s)));
  return [...kademeler.map((k) => `${k}. sınıflar`), ...tekil].join(", ");
}

window.duyuruKademe = (btn) => {
  const set = _sinifSet(btn.dataset.ad);
  const liste = siniflarSirali().filter((s) => (kademe(s) || "Diğer") === btn.dataset.k);
  const hepsi = liste.every((s) => set.has(s));
  liste.forEach((s) => (hepsi ? set.delete(s) : set.add(s)));
  _sinifSecimYenile(btn.dataset.ad);
};
window.duyuruSinif = (btn) => {
  const set = _sinifSet(btn.dataset.ad);
  set.has(btn.dataset.s) ? set.delete(btn.dataset.s) : set.add(btn.dataset.s);
  _sinifSecimYenile(btn.dataset.ad);
};
function _sinifSecimYenile(ad) {
  if (ad === "zamanli") {
    document.getElementById("zmSiniflar").innerHTML = _sinifSecimHtml(_zamanliSiniflar, "zamanli");
  } else {
    document.getElementById("duyuruHedefDetay").innerHTML = _sinifDetayHtml();
    _ozetCiz();
  }
}
function _sinifDetayHtml() {
  return `<div style="font-size:12px;color:var(--text2);margin-bottom:6px;">Haftalık ders programına göre seçili şubelerde dersi olan öğretmenler.</div>${_sinifSecimHtml(_seciliSiniflar, "anlik")}`;
}

function ogretmenlerSirali() {
  return [...state.ogretmenler].sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"));
}

function zumreAdi(o) {
  return (o.brans || "").trim() || "Branşsız";
}

function alicilar() {
  const hepsi = ogretmenlerSirali();
  if (_hedefTip === "hepsi") return hepsi;
  if (_hedefTip === "zumre") return hepsi.filter((o) => _seciliZumreler.has(zumreAdi(o)));
  if (_hedefTip === "sinif") {
    const ids = new Set();
    _seciliSiniflar.forEach((s) => (_programOgretmenleri[s] || []).forEach((id) => ids.add(id)));
    return hepsi.filter((o) => ids.has(o.id));
  }
  return hepsi.filter((o) => _seciliOgretmenler.has(o.id));
}

function hedefOzeti(liste) {
  if (_hedefTip === "hepsi") return "Tüm öğretmenler";
  if (_hedefTip === "zumre") return "Zümre: " + [..._seciliZumreler].sort((a, b) => a.localeCompare(b, "tr")).join(", ");
  if (_hedefTip === "sinif") return "Sınıf: " + _sinifOzet(_seciliSiniflar);
  return `Seçili ${liste.length} öğretmen`;
}

export async function bildirimGonderYukle() {
  window.duyuruHedefSec(_hedefTip);
  window.duyuruSayac();
  _gecmisYukle();
  _zamanliFormCiz();
  _zamanliYukle();
  try {
    await _programYukle();
    if (_hedefTip === "sinif") _ozetCiz();
  } catch (err) {
    console.warn("Ders programi okunamadi:", err);
  }
}
window.bildirimGonderYukle = bildirimGonderYukle;

window.duyuruSayac = () => {
  const b = document.getElementById("duyuruBaslik");
  const m = document.getElementById("duyuruMesaj");
  document.getElementById("duyuruBaslikSayac").textContent = `${b.value.length} / 100`;
  document.getElementById("duyuruMesajSayac").textContent = `${m.value.length} / 1000`;
};

window.duyuruHedefSec = (tip) => {
  _hedefTip = tip;
  ["hepsi", "zumre", "secili", "sinif"].forEach((t) =>
    document.getElementById("duyuruHedef-" + t)?.classList.toggle("aktif", t === tip));
  const alan = document.getElementById("duyuruHedefDetay");
  if (tip === "hepsi") {
    alan.innerHTML = "";
  } else if (tip === "sinif") {
    alan.innerHTML = _sinifDetayHtml();
  } else if (tip === "zumre") {
    const sayilar = {};
    state.ogretmenler.forEach((o) => (sayilar[zumreAdi(o)] = (sayilar[zumreAdi(o)] || 0) + 1));
    alan.innerHTML = '<div class="duyuru-chipler">' + Object.keys(sayilar)
      .sort((a, b) => a.localeCompare(b, "tr"))
      .map((z) => `<button type="button" class="duyuru-chip${_seciliZumreler.has(z) ? " secili" : ""}" data-zumre="${esc(z)}" onclick="duyuruZumre(this)">${esc(z)} <small>(${sayilar[z]})</small></button>`)
      .join("") + "</div>";
  } else {
    alan.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <input type="text" id="duyuruAra" placeholder="Öğretmen ara..." oninput="duyuruListeCiz()" style="flex:1;min-width:180px;" />
        <button type="button" class="btn btn-gri btn-sm" onclick="duyuruTumunu(true)">Görünenleri seç</button>
        <button type="button" class="btn btn-gri btn-sm" onclick="duyuruTumunu(false)">Temizle</button>
      </div>
      <div id="duyuruOgretmenListe" class="duyuru-ogretmen-liste"></div>`;
    window.duyuruListeCiz();
  }
  _ozetCiz();
};

window.duyuruZumre = (btn) => {
  const z = btn.dataset.zumre;
  if (_seciliZumreler.has(z)) _seciliZumreler.delete(z); else _seciliZumreler.add(z);
  btn.classList.toggle("secili");
  _ozetCiz();
};

function _gorunenOgretmenler() {
  const q = (document.getElementById("duyuruAra")?.value || "").trim().toLocaleLowerCase("tr");
  return ogretmenlerSirali().filter((o) => !q || (o.ad || "").toLocaleLowerCase("tr").includes(q) || zumreAdi(o).toLocaleLowerCase("tr").includes(q));
}

window.duyuruListeCiz = () => {
  const el = document.getElementById("duyuruOgretmenListe");
  if (!el) return;
  const gruplar = {};
  _gorunenOgretmenler().forEach((o) => (gruplar[zumreAdi(o)] ||= []).push(o));
  const zumreler = Object.keys(gruplar).sort((a, b) => a.localeCompare(b, "tr"));
  el.innerHTML = zumreler.length
    ? zumreler.map((z) => `<div class="duyuru-grup-baslik">${esc(z)}</div>` + gruplar[z].map((o) =>
        `<label class="duyuru-ogretmen"><input type="checkbox" data-id="${esc(o.id)}" ${_seciliOgretmenler.has(o.id) ? "checked" : ""} onchange="duyuruOgretmen(this)" /> ${esc(o.ad)}</label>`).join("")).join("")
    : '<div class="bos-mesaj">Eşleşen öğretmen yok.</div>';
};

window.duyuruOgretmen = (cb) => {
  if (cb.checked) _seciliOgretmenler.add(cb.dataset.id); else _seciliOgretmenler.delete(cb.dataset.id);
  _ozetCiz();
};

window.duyuruTumunu = (sec) => {
  if (sec) _gorunenOgretmenler().forEach((o) => _seciliOgretmenler.add(o.id));
  else _seciliOgretmenler.clear();
  window.duyuruListeCiz();
  _ozetCiz();
};

function _ozetCiz() {
  const liste = alicilar();
  const el = document.getElementById("duyuruOzet");
  if (!el) return;
  el.innerHTML = liste.length
    ? `<strong>${liste.length} öğretmene gönderilecek</strong>
       <details style="margin-top:4px;"><summary style="cursor:pointer;font-size:13px;color:var(--text2);">Alıcıları göster</summary>
       <div style="font-size:13px;color:var(--text2);margin-top:4px;">${liste.map((o) => esc(o.ad)).join(", ")}</div></details>`
    : '<span style="color:var(--text2);">Henüz alıcı seçilmedi.</span>';
}

window.duyuruGonder = async () => {
  const baslik = document.getElementById("duyuruBaslik").value.trim();
  const mesaj = document.getElementById("duyuruMesaj").value.trim();
  const liste = alicilar();
  if (!baslik || !mesaj) { mesajGoster("duyuruSonuc", "Başlık ve mesaj zorunludur.", "hata"); return; }
  if (baslik.length > 100 || mesaj.length > 1000) { mesajGoster("duyuruSonuc", "Başlık en fazla 100, mesaj en fazla 1000 karakter olabilir.", "hata"); return; }
  if (!liste.length) { mesajGoster("duyuruSonuc", "En az bir alıcı seçin.", "hata"); return; }
  if (!await sor("Bildirimi Gönder", `"${baslik}" başlıklı bildirim ${liste.length} öğretmene gönderilecek.`, "Gönder", "btn-mavi")) return;

  const btn = document.getElementById("duyuruGonderBtn");
  btn.disabled = true;
  mesajGoster("duyuruSonuc", "Gönderiliyor...", "bilgi");
  try {
    const { data } = await httpsCallable(functions, "idareMesajiGonder")({
      baslik, mesaj, ogretmenIds: liste.map((o) => o.id), hedefOzet: hedefOzeti(liste),
    });
    mesajGoster("duyuruSonuc",
      `${data.alici} öğretmene gönderildi.` + (data.cihaz ? ` ${data.basarili} telefona bildirim ulaştı.` : " Henüz telefon bildirimini açmış öğretmen yok; mesaj zile ve giriş penceresine düştü."),
      "basari");
    document.getElementById("duyuruBaslik").value = "";
    document.getElementById("duyuruMesaj").value = "";
    window.duyuruSayac();
    _gecmisYukle();
  } catch (err) {
    mesajGoster("duyuruSonuc", "Hata: " + err.message, "hata");
  }
  btn.disabled = false;
};

// ── Gönderilenler ──
let _gecmis = [];

async function _gecmisYukle() {
  const el = document.getElementById("duyuruGecmis");
  if (!el) return;
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const snap = await getDocs(collection(db, "idare_mesajlari"));
    _gecmis = [];
    snap.forEach((d) => _gecmis.push({ id: d.id, ...d.data() }));
    _gecmis.sort((a, b) => (b.tarih?.toMillis?.() || 0) - (a.tarih?.toMillis?.() || 0));
    _gecmis = _gecmis.slice(0, 50);
    if (!_gecmis.length) { el.innerHTML = '<div class="bos-mesaj">Henüz bildirim gönderilmedi.</div>'; return; }
    el.innerHTML = _gecmis.map((m) => {
      const t = m.tarih?.toDate ? m.tarih.toDate().toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
      return `<div class="duyuru-gecmis-satir">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div><strong>${esc(m.baslik)}</strong>
            <div style="font-size:12px;color:var(--text2);">${esc(t)} · ${esc(m.hedef_ozet || "")} · ${m.alici_sayisi || 0} alıcı${m.push_cihaz ? ` · ${m.push_basarili || 0}/${m.push_cihaz} telefon` : ""} · ${esc(m.gonderen_ad || "")}</div></div>
          <button class="btn btn-gri btn-sm" data-id="${esc(m.id)}" onclick="duyuruOkunma(this)">Okunma</button>
        </div>
        <div style="font-size:13px;margin-top:6px;white-space:pre-wrap;">${esc(m.mesaj)}</div>
        <div id="duyuruOkunma_${esc(m.id)}" style="font-size:13px;margin-top:6px;"></div>
      </div>`;
    }).join("");
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}

window.duyuruOkunma = async (btn) => {
  const id = btn.dataset.id;
  const el = document.getElementById("duyuruOkunma_" + id);
  el.textContent = "Yukleniyor...";
  try {
    const snap = await getDocs(query(collection(db, "bildirimler"), where("referans_id", "==", id)));
    const okuyan = new Set(), okumayan = [];
    snap.forEach((d) => {
      const b = d.data();
      if (b.tip !== "idare_mesaji") return;
      if (b.okundu) okuyan.add(b.alici_id); else okumayan.push(b.alici_id);
    });
    const ad = (oid) => state.ogretmenler.find((o) => o.id === oid)?.ad || "?";
    const toplam = okuyan.size + okumayan.length;
    el.innerHTML = `<strong>Okudu: ${okuyan.size} / ${toplam}</strong>` +
      (okumayan.length ? `<div style="color:var(--text2);margin-top:2px;">Okumayanlar: ${okumayan.map((x) => esc(ad(x))).sort((a, b) => a.localeCompare(b, "tr")).join(", ")}</div>` : "");
  } catch (err) {
    el.textContent = "Yüklenemedi: " + err.message;
  }
};

// ── Zamanlanmış bildirimler ──
// zamanli_bildirimler kurallari; gonderimi sunucu yapar (zamanliBildirimGonder,
// her dakika): alicilar o saatte secili subelerde derste olan ogretmenler.
const GUN_KISA = { 1: "Pzt", 2: "Sal", 3: "Çar", 4: "Per", 5: "Cum" };
let _zamanli = [];

function _zamanliFormCiz() {
  const el = document.getElementById("zamanliForm");
  if (!el) return;
  el.innerHTML = `<details id="zmDetay"><summary style="cursor:pointer;font-weight:600;">➕ Yeni zamanlanmış bildirim</summary>
    <div style="margin-top:10px;">
      <div class="form-grid">
        <div class="form-group"><label>Başlık</label><input type="text" id="zmBaslik" maxlength="100" placeholder="Ör. Ders sonu hatırlatma" /></div>
        <div class="form-group"><label>Saat</label><input type="time" id="zmSaat" min="07:00" max="18:59" /></div>
      </div>
      <div class="form-group"><label>Mesaj</label><textarea id="zmMesaj" maxlength="1000" rows="3" placeholder="Mesajınızı yazın..."></textarea></div>
      <div class="form-group"><label>Ne zaman</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:13px;">
          <label style="display:flex;gap:4px;align-items:center;"><input type="radio" name="zmTur" value="haftalik" checked onchange="zamanliTurDegisti()">Her hafta:</label>
          <span id="zmGunler" style="display:flex;gap:8px;flex-wrap:wrap;">${Object.entries(GUN_KISA).map(([g, ad]) =>
            `<label style="display:flex;gap:3px;align-items:center;"><input type="checkbox" class="zmGun" value="${g}" checked>${ad}</label>`).join("")}</span>
          <label style="display:flex;gap:4px;align-items:center;"><input type="radio" name="zmTur" value="tek" onchange="zamanliTurDegisti()">Tek seferlik:</label>
          <input type="date" id="zmTarih" disabled />
        </div>
      </div>
      <div class="form-group"><label>Hangi şubelerde derste olan öğretmenlere</label><div id="zmSiniflar">${_sinifSecimHtml(_zamanliSiniflar, "zamanli")}</div></div>
      <button class="btn btn-mavi" onclick="zamanliKaydet()">⏰ Zamanla</button>
      <div class="mesaj" id="zamanliMesaj" style="margin-top:8px;"></div>
    </div></details>`;
}

window.zamanliTurDegisti = () => {
  const tek = document.querySelector('input[name="zmTur"]:checked')?.value === "tek";
  document.getElementById("zmTarih").disabled = !tek;
  document.querySelectorAll(".zmGun").forEach((c) => (c.disabled = tek));
};

window.zamanliKaydet = async () => {
  const baslik = document.getElementById("zmBaslik").value.trim();
  const mesaj = document.getElementById("zmMesaj").value.trim();
  const saat = document.getElementById("zmSaat").value;
  const tek = document.querySelector('input[name="zmTur"]:checked')?.value === "tek";
  const tarih = document.getElementById("zmTarih").value;
  const gunler = [...document.querySelectorAll(".zmGun:checked")].map((c) => Number(c.value));
  const hata = (m) => mesajGoster("zamanliMesaj", m, "hata");
  if (!baslik || !mesaj) return hata("Başlık ve mesaj zorunludur.");
  if (!saat || saat < "07:00" || saat > "18:59") return hata("Saat 07:00 ile 18:59 arasında olmalı.");
  if (tek && !tarih) return hata("Tek seferlik bildirim için tarih seçin.");
  if (tek) { const g = new Date(tarih + "T12:00:00").getDay(); if (g === 0 || g === 6) return hata("Hafta sonuna bildirim zamanlanamaz."); }
  if (!tek && !gunler.length) return hata("En az bir gün seçin.");
  if (!_zamanliSiniflar.size) return hata("En az bir şube seçin.");
  try {
    await addDoc(collection(db, "zamanli_bildirimler"), {
      baslik, mesaj, saat,
      gunler: tek ? [] : gunler, tek_tarih: tek ? tarih : null,
      hedef_siniflar: [..._zamanliSiniflar], hedef_ozet: _sinifOzet(_zamanliSiniflar),
      aktif: true, son_gonderim: null, son_sonuc: "",
      olusturan_uid: auth.currentUser?.uid || null, olusturan_ad: state.kullanici?.ad || "İdare",
      olusturma: serverTimestamp(),
    });
    _zamanliSiniflar.clear();
    _zamanliFormCiz();
    mesajGoster("zamanliMesaj", "Zamanlandı.", "basari");
    _zamanliYukle();
  } catch (err) {
    hata("Kaydedilemedi: " + err.message);
  }
};

async function _zamanliYukle() {
  const el = document.getElementById("zamanliListe");
  if (!el) return;
  try {
    const snap = await getDocs(collection(db, "zamanli_bildirimler"));
    _zamanli = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.aktif === true) - (a.aktif === true) || String(a.saat).localeCompare(String(b.saat)));
    if (!_zamanli.length) { el.innerHTML = '<div class="bos-mesaj">Zamanlanmış bildirim yok.</div>'; return; }
    el.innerHTML = `<div style="overflow-x:auto;"><table><thead><tr><th>Saat</th><th>Ne zaman</th><th>Bildirim</th><th>Şubeler</th><th>Son gönderim</th><th></th></tr></thead><tbody>
      ${_zamanli.map((z) => {
        const ne = z.tek_tarih ? `Tek sefer: ${z.tek_tarih.split("-").reverse().join(".")}` : (z.gunler || []).map((g) => GUN_KISA[g]).join(", ");
        const son = z.son_gonderim ? `${z.son_gonderim.split("-").reverse().join(".")}: ${z.son_sonuc || ""}` : "—";
        return `<tr style="${z.aktif ? "" : "opacity:.55;"}">
          <td style="font-weight:700;white-space:nowrap;">${esc(z.saat)}</td>
          <td style="font-size:12px;">${esc(ne)}${z.aktif ? "" : ' <span class="rozet rozet-gri" style="font-size:11px;">duraklatıldı</span>'}</td>
          <td><strong>${esc(z.baslik)}</strong><div style="font-size:12px;color:var(--text2);white-space:pre-wrap;">${esc(z.mesaj)}</div></td>
          <td style="font-size:12px;">${esc(z.hedef_ozet || (z.hedef_siniflar || []).join(", "))}</td>
          <td style="font-size:12px;">${esc(son)}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-gri btn-sm" data-id="${esc(z.id)}" onclick="zamanliAktiflik(this.dataset.id)">${z.aktif ? "Duraklat" : "Etkinleştir"}</button>
            <button class="btn btn-kirmizi btn-sm" data-id="${esc(z.id)}" onclick="zamanliSil(this.dataset.id)">Sil</button>
          </td></tr>`;
      }).join("")}
      </tbody></table></div>`;
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}

window.zamanliAktiflik = async (id) => {
  const z = _zamanli.find((x) => x.id === id);
  if (!z) return;
  try {
    await updateDoc(doc(db, "zamanli_bildirimler", id), { aktif: !z.aktif });
    _zamanliYukle();
  } catch (err) {
    mesajGoster("zamanliMesaj", "Hata: " + err.message, "hata");
  }
};

window.zamanliSil = async (id) => {
  const z = _zamanli.find((x) => x.id === id);
  if (!z || !await sor("Zamanlanmış Bildirimi Sil", `"${z.baslik}" (${z.saat}) silinecek; bundan sonra gönderilmez. Daha önce gönderilenler arşivde kalır.`, "Sil", "btn-kirmizi")) return;
  try {
    await deleteDoc(doc(db, "zamanli_bildirimler", id));
    _zamanliYukle();
  } catch (err) {
    mesajGoster("zamanliMesaj", "Hata: " + err.message, "hata");
  }
};
