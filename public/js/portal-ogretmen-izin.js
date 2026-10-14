import {
  db, auth, bugunHesapla,
  getDocs, addDoc, updateDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── İZİN TALEBİM (öğretmen) ──
// Ogretmen kendi iznini (mazeret / saglik) girer: ogretmen_izinleri'ne
// durum "beklemede" ile yazilir. Admin'e Telegram'dan haber gider, bugunun
// dersleri icin vekil onerilir (functions: ogretmenIzniGirildi); admin Vekil
// Atama sayfasindan onaylar. Bekleyen talep iptal edilebilir; onayli izin
// icin "yarida kesme" talebi iletilir (kesme_talebi).

const TUR_AD = { mazeret: "Mazeret izni", saglik: "Sağlık izni" };
const trTarih = (t) => (t ? String(t).split("-").reverse().join(".") : "");
const aralik = (iz) => (iz.baslangic_tarihi === iz.bitis_tarihi
  ? trTarih(iz.baslangic_tarihi) : `${trTarih(iz.baslangic_tarihi)} – ${trTarih(iz.bitis_tarihi)}`);
const kok = () => document.getElementById("sayfa-izin-talebim");

let _izinler = [];
let _acikKesme = null;  // yarida kesme formu acik izin id

export async function izinTalebimYukle() {
  const bugun = bugunHesapla();
  kok().innerHTML = `
    <div class="kart">
      <div class="kart-baslik">🏥 İzin Talebi Oluştur</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Talebiniz idareye iletilir ve derslerinize vekil önerilir. İdare onaylayınca vekil öğretmenlere bildirim gider.</p>
      <div class="form-grid">
        <div class="form-group"><label>İzin türü</label>
          <select id="izTur">
            <option value="">Seçin...</option>
            <option value="mazeret">Mazeret izni</option>
            <option value="saglik">Sağlık izni</option>
          </select></div>
        <div class="form-group"><label>Başlangıç tarihi</label><input type="date" id="izBas" min="${bugun}" value="${bugun}" onchange="izinBasDegisti()"></div>
        <div class="form-group"><label>Bitiş tarihi</label><input type="date" id="izBit" min="${bugun}" value="${bugun}"></div>
        <div class="form-group"><label>Açıklama (isteğe bağlı)</label><input type="text" id="izAciklama" maxlength="200" placeholder="Ör. hastane randevusu"></div>
      </div>
      <button class="btn btn-yesil" id="izGonderBtn" onclick="izinTalebiGonder()">📨 Gönder</button>
      <div class="mesaj" id="izMesaj"></div>
    </div>
    <div class="kart">
      <div class="kart-baslik">Taleplerim</div>
      <div id="izListe"><div class="yukleniyor">Yukleniyor...</div></div>
    </div>`;
  await _listeYukle();
}
window.izinTalebimYukle = izinTalebimYukle;

window.izinBasDegisti = () => {
  const bas = document.getElementById("izBas").value;
  const bit = document.getElementById("izBit");
  bit.min = bas;
  if (bit.value < bas) bit.value = bas;
};

async function _listeYukle() {
  const el = document.getElementById("izListe");
  if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, "ogretmen_izinleri"), where("ogretmen_uid", "==", auth.currentUser.uid)));
    _izinler = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.baslangic_tarihi || "").localeCompare(a.baslangic_tarihi || ""));
    _listeCiz();
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}

function _durumRozeti(iz) {
  const k = iz.kesme_talebi;
  if (iz.durum === "onaylandi" && k?.durum === "onaylandi") return `<span class="rozet rozet-mavi">↩️ Yarıda kesildi — dönüş ${esc(trTarih(k.donus_tarihi))}</span>`;
  if (iz.durum === "onaylandi" && k?.durum === "beklemede") return '<span class="rozet rozet-turuncu">↩️ Yarıda kesme onay bekliyor</span>';
  return {
    beklemede: '<span class="rozet rozet-sari">⏳ Onay bekliyor</span>',
    onaylandi: '<span class="rozet rozet-yesil">✅ Onaylandı</span>',
    reddedildi: '<span class="rozet rozet-kirmizi">❌ Reddedildi</span>',
    iptal: '<span class="rozet rozet-gri">İptal edildi</span>',
  }[iz.durum] || "";
}

function _listeCiz() {
  const el = document.getElementById("izListe");
  if (!el) return;
  if (!_izinler.length) { el.innerHTML = '<div class="bos-mesaj">Henüz izin talebiniz yok.</div>'; return; }
  const bugun = bugunHesapla();
  el.innerHTML = _izinler.map((iz) => {
    const k = iz.kesme_talebi;
    const kesilebilir = iz.durum === "onaylandi" && iz.bitis_tarihi >= bugun && k?.durum !== "beklemede" && k?.durum !== "onaylandi";
    const enErken = iz.baslangic_tarihi > bugun ? iz.baslangic_tarihi : bugun;
    return `<div class="kart" style="margin-bottom:8px;padding:12px;">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
        <div><strong>${esc(TUR_AD[iz.tur] || iz.tur)}</strong> · ${esc(aralik(iz))}
          ${iz.ilk_bitis_tarihi ? `<span style="font-size:12px;color:var(--text2);"> (ilk bitiş ${esc(trTarih(iz.ilk_bitis_tarihi))})</span>` : ""}
          ${iz.aciklama ? `<div style="font-size:12px;color:var(--text2);">${esc(iz.aciklama)}</div>` : ""}</div>
        <div>${_durumRozeti(iz)}</div>
      </div>
      ${iz.durum === "reddedildi" && iz.red_notu ? `<div style="font-size:13px;margin-top:4px;">Not: ${esc(iz.red_notu)}</div>` : ""}
      ${k?.durum === "reddedildi" ? `<div style="font-size:13px;margin-top:4px;color:#c5221f;">Yarıda kesme talebi reddedildi${k.red_notu ? ": " + esc(k.red_notu) : ""}.</div>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${iz.durum === "beklemede" ? `<button class="btn btn-gri btn-sm" data-id="${esc(iz.id)}" onclick="izinTalebiIptal(this.dataset.id)">İptal et</button>` : ""}
        ${kesilebilir ? `<button class="btn btn-turuncu btn-sm" style="background:#e65100;color:#fff;" data-id="${esc(iz.id)}" onclick="izinKesmeAc(this.dataset.id)">↩️ İzni yarıda kes</button>` : ""}
      </div>
      ${kesilebilir && _acikKesme === iz.id ? `<div style="margin-top:10px;padding:10px;background:#fff3e0;border-radius:8px;">
        <div style="font-size:13px;margin-bottom:6px;">Okula döneceğiniz günü seçin. İdare onaylayınca o günden itibaren vekil atamaları kaldırılır.</div>
        <div class="form-grid">
          <div class="form-group"><label>Okula dönüş tarihi</label><input type="date" id="izKesmeTarih" min="${enErken}" max="${iz.bitis_tarihi}" value="${enErken}"></div>
          <div class="form-group"><label>Açıklama (isteğe bağlı)</label><input type="text" id="izKesmeAciklama" maxlength="200"></div>
        </div>
        <button class="btn btn-yesil btn-sm" data-id="${esc(iz.id)}" onclick="izinKesmeGonder(this.dataset.id, this)">📨 Talebi gönder</button>
        <button class="btn btn-gri btn-sm" onclick="izinKesmeAc(null)">Vazgeç</button>
      </div>` : ""}
    </div>`;
  }).join("");
}

window.izinTalebiGonder = async () => {
  const tur = document.getElementById("izTur").value;
  const bas = document.getElementById("izBas").value;
  const bit = document.getElementById("izBit").value;
  const aciklama = document.getElementById("izAciklama").value.trim();
  if (!tur) { mesajGoster("izMesaj", "İzin türünü seçin.", "hata"); return; }
  if (!bas || !bit || bit < bas) { mesajGoster("izMesaj", "Geçerli bir tarih aralığı girin.", "hata"); return; }
  if (bas < bugunHesapla()) { mesajGoster("izMesaj", "Geçmiş tarihli izin girilemez.", "hata"); return; }
  if (!state.ogretmenDoc) { mesajGoster("izMesaj", "Öğretmen kaydınız bulunamadı.", "hata"); return; }
  const cakisan = _izinler.find((iz) => ["beklemede", "onaylandi"].includes(iz.durum) && iz.baslangic_tarihi <= bit && iz.bitis_tarihi >= bas);
  if (cakisan && !await sor("Çakışan İzin", `Bu tarihlerle çakışan bir izniniz var (${aralik(cakisan)}). Yine de gönderilsin mi?`, "Gönder", "btn-mavi")) return;
  const btn = document.getElementById("izGonderBtn");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "ogretmen_izinleri"), {
      ogretmen_id: state.ogretmenDoc.id,
      ogretmen_ad: state.ogretmenDoc.ad || state.kullanici?.ad || "",
      ogretmen_uid: auth.currentUser.uid,
      tur, baslangic_tarihi: bas, bitis_tarihi: bit, aciklama,
      durum: "beklemede",
      olusturma: serverTimestamp(),
    });
    document.getElementById("izAciklama").value = "";
    document.getElementById("izTur").value = "";
    mesajGoster("izMesaj", "İzin talebiniz idareye iletildi.", "basari");
    await _listeYukle();
  } catch (err) {
    mesajGoster("izMesaj", "Gönderilemedi: " + err.message, "hata");
  }
  btn.disabled = false;
};

window.izinTalebiIptal = async (id) => {
  if (!await sor("Talebi İptal Et", "Bu izin talebi iptal edilecek.", "İptal et", "btn-kirmizi")) return;
  try {
    await updateDoc(doc(db, "ogretmen_izinleri", id), { durum: "iptal", iptal_zamani: serverTimestamp() });
    await _listeYukle();
  } catch (err) {
    mesajGoster("izMesaj", "İptal edilemedi: " + err.message, "hata");
  }
};

window.izinKesmeAc = (id) => { _acikKesme = id; _listeCiz(); };

window.izinKesmeGonder = async (id, btn) => {
  const iz = _izinler.find((x) => x.id === id);
  const tarih = document.getElementById("izKesmeTarih").value;
  const aciklama = document.getElementById("izKesmeAciklama").value.trim();
  if (!iz || !tarih || tarih < bugunHesapla() || tarih < iz.baslangic_tarihi || tarih > iz.bitis_tarihi) {
    mesajGoster("izMesaj", "İzin aralığında, bugün ya da sonrası bir dönüş tarihi seçin.", "hata");
    return;
  }
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "ogretmen_izinleri", id), {
      kesme_talebi: { donus_tarihi: tarih, aciklama, durum: "beklemede", zaman: serverTimestamp() },
    });
    _acikKesme = null;
    mesajGoster("izMesaj", "Yarıda kesme talebiniz idareye iletildi.", "basari");
    await _listeYukle();
  } catch (err) {
    mesajGoster("izMesaj", "Gönderilemedi: " + err.message, "hata");
    btn.disabled = false;
  }
};
