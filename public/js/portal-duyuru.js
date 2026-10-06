import {
  db, functions, httpsCallable,
  getDocs, collection, query, where,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── BİLDİRİM GÖNDER (admin) ──
// Hedef (tum ogretmenler / zumre / secili) burada ogretmen id'lerine cozulur;
// idareMesajiGonder bunlari dogrulayip zile ve telefona gonderir, arsivler.

let _hedefTip = "hepsi";
const _seciliZumreler = new Set();
const _seciliOgretmenler = new Set();

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
  return hepsi.filter((o) => _seciliOgretmenler.has(o.id));
}

function hedefOzeti(liste) {
  if (_hedefTip === "hepsi") return "Tüm öğretmenler";
  if (_hedefTip === "zumre") return "Zümre: " + [..._seciliZumreler].sort((a, b) => a.localeCompare(b, "tr")).join(", ");
  return `Seçili ${liste.length} öğretmen`;
}

export function bildirimGonderYukle() {
  window.duyuruHedefSec(_hedefTip);
  window.duyuruSayac();
  _gecmisYukle();
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
  ["hepsi", "zumre", "secili"].forEach((t) =>
    document.getElementById("duyuruHedef-" + t)?.classList.toggle("aktif", t === tip));
  const alan = document.getElementById("duyuruHedefDetay");
  if (tip === "hepsi") {
    alan.innerHTML = "";
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
