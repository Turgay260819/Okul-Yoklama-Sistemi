import {
  db, functions, bugunHesapla,
  getDocs, addDoc, deleteDoc, updateDoc,
  collection, query, where, doc, serverTimestamp, httpsCallable,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── VEKİL ATAMA SAYFASI ──
export function vekilAtamaSayfasiBaslat() {
  _ogretmenSecimDoldur();
  _raporListesiYukle();
  _izinleriYukle();

  const basEl = document.getElementById("vekilGecmisBaslangic");
  const bitEl = document.getElementById("vekilGecmisBitis");
  if (basEl && !basEl.value) {
    const ayBas = new Date();
    ayBas.setDate(1);
    basEl.value = ayBas.toISOString().split("T")[0];
  }
  if (bitEl && !bitEl.value) bitEl.value = bugunHesapla();
  _gecmisVekilYukle();
}
window.vekilAtamaSayfasiBaslat = vekilAtamaSayfasiBaslat;

const tarihTR = (t) => String(t || "").split("-").reverse().join(".");
const IZIN_TUR_AD = { mazeret: "Mazeret izni", saglik: "Sağlık izni" };
const TIER_ETIKET = { nobetci: "🛡 Nöbetçi", diger: "👤 Diğer", manuel: "✋ Elle" };

function _ogretmenSecimDoldur() {
  const select = document.getElementById("vekilOgretmenSecim");
  if (!select) return;
  select.innerHTML = '<option value="">Ogretmen secin...</option>';
  [...state.ogretmenler]
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .forEach((o) => (select.innerHTML += `<option value="${o.id}">${esc(o.ad)}</option>`));
}

function _ogretmenOptionsHtml(haricId, seciliId = "") {
  return [...state.ogretmenler]
    .filter((o) => o.id !== haricId)
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .map((o) => `<option value="${o.id}"${o.id === seciliId ? " selected" : ""}>${esc(o.ad)}</option>`)
    .join("");
}

// ── ONAY BEKLEYEN ÖĞRETMEN İZİNLERİ ──
// Ogretmenlerin "Izin Talebim"den girdigi izinler ve onayli izinler icin
// yarida kesme talepleri. Karar ogretmenIzinKarar fonksiyonunda verilir.
let _izinler = [];

async function _izinleriYukle() {
  const kart = document.getElementById("vekilIzinKart");
  const el = document.getElementById("vekilIzinListesi");
  if (!kart || !el) return;
  try {
    const bugun = bugunHesapla();
    const [bekleyen, kesme, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "ogretmen_izinleri"), where("durum", "==", "beklemede"))),
      getDocs(query(collection(db, "ogretmen_izinleri"), where("kesme_talebi.durum", "==", "beklemede"))),
      getDocs(query(collection(db, "today_lessons"), where("date", "==", bugun))),
    ]);
    const dersler = dersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    _izinler = [
      ...bekleyen.docs.map((d) => ({ id: d.id, tip: "izin", ...d.data() })),
      ...kesme.docs.map((d) => ({ id: d.id, tip: "kesme", ...d.data() })).filter((iz) => iz.durum === "onaylandi"),
    ].sort((a, b) => (a.baslangic_tarihi || "").localeCompare(b.baslangic_tarihi || ""));
    kart.hidden = !_izinler.length;
    el.innerHTML = _izinler.map((iz) => (iz.tip === "kesme" ? _kesmeKarti(iz, dersler, bugun) : _izinKarti(iz, bugun))).join("");
  } catch (err) {
    kart.hidden = false;
    el.innerHTML = `<div class="bos-mesaj">İzin talepleri yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.vekilIzinleriYukle = _izinleriYukle;

const _aralik = (iz) => (iz.baslangic_tarihi === iz.bitis_tarihi
  ? tarihTR(iz.baslangic_tarihi) : `${tarihTR(iz.baslangic_tarihi)} – ${tarihTR(iz.bitis_tarihi)}`);
const _zaman = (z) => (z?.toDate ? z.toDate().toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

function _izinKarti(iz, bugun) {
  const oneri = iz.oneriler?.tarih === bugun ? iz.oneriler.dersler || [] : null;
  let govde;
  if (iz.baslangic_tarihi > bugun) {
    govde = `<div style="font-size:13px;color:var(--text2);">İzin ${esc(tarihTR(iz.baslangic_tarihi))}'de başlıyor; onaylanırsa o gün sabah 07:00'de vekiller otomatik atanır ve öğretmenlere bildirilir.</div>`;
  } else if (!oneri) {
    govde = '<div style="font-size:13px;color:var(--text2);">Bugün için vekil önerisi yok (hafta sonu/tatil ya da dersler henüz oluşmadı). Onaylanınca vekilsiz dersler otomatik atanır.</div>';
  } else if (!oneri.length) {
    govde = '<div style="font-size:13px;color:var(--text2);">Bugün vekil gerektiren dersi yok.</div>';
  } else {
    govde = `<div style="font-size:13px;font-weight:600;margin-bottom:4px;">Bugünkü dersler için önerilen vekiller (değiştirebilirsiniz):</div>
      <div style="overflow-x:auto;"><table style="width:100%;font-size:13px;"><tbody>
      ${oneri.slice().sort((a, b) => a.lessonNumber - b.lessonNumber).map((d) => `<tr>
        <td style="padding:4px 6px;white-space:nowrap;">${d.lessonNumber}. ders</td>
        <td style="padding:4px 6px;">${esc(d.classId)} ${esc(d.lessonName || "")}</td>
        <td style="padding:4px 6px;">${d.atandi ? `${TIER_ETIKET[d.tier] || ""}` : '<span style="color:#ea4335;">⚠️ Uygun vekil yok</span>'}</td>
        <td style="padding:4px 6px;"><select class="viz-sec" data-izin="${esc(iz.id)}" data-ders="${esc(d.dersId)}" style="font-size:12px;max-width:170px;">
          <option value="">${d.atandi ? "—" : "Otomatik dene"}</option>${_ogretmenOptionsHtml(iz.ogretmen_id, d.vekilId)}</select></td></tr>`).join("")}
      </tbody></table></div>`;
  }
  return `<div class="kart" style="margin-bottom:10px;border-left:4px solid #f9a825;">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <div><strong>${esc(iz.ogretmen_ad)}</strong> — ${esc(IZIN_TUR_AD[iz.tur] || iz.tur)} · <strong>${esc(_aralik(iz))}</strong>
        ${iz.aciklama ? `<div style="font-size:12px;color:var(--text2);">${esc(iz.aciklama)}</div>` : ""}</div>
      <div style="font-size:12px;color:var(--text2);">Girildi: ${esc(_zaman(iz.olusturma))}</div>
    </div>
    <div style="margin:8px 0;">${govde}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-yesil btn-sm" data-id="${esc(iz.id)}" onclick="vekilIzinKarar(this.dataset.id, 'onay', this)">✔ Onayla ve vekilleri ata</button>
      <input type="text" id="vizNot_${esc(iz.id)}" placeholder="Red notu (isteğe bağlı)" style="font-size:12px;max-width:220px;">
      <button class="btn btn-kirmizi btn-sm" data-id="${esc(iz.id)}" onclick="vekilIzinKarar(this.dataset.id, 'red', this)">✖ Reddet</button>
    </div></div>`;
}

function _kesmeKarti(iz, dersler, bugun) {
  const k = iz.kesme_talebi || {};
  const kalkacak = k.donus_tarihi <= bugun
    ? dersler.filter((d) => d.teacher_id === iz.ogretmen_id && d.substitute_teacher_id).sort((a, b) => a.lesson_number - b.lesson_number)
    : [];
  return `<div class="kart" style="margin-bottom:10px;border-left:4px solid #e65100;">
    <div><strong>↩️ ${esc(iz.ogretmen_ad)}</strong> iznini yarıda kesmek istiyor — ${esc(IZIN_TUR_AD[iz.tur] || iz.tur)} (${esc(_aralik(iz))})</div>
    <div style="font-size:13px;margin-top:4px;">Okula dönüş: <strong>${esc(tarihTR(k.donus_tarihi))}</strong>${k.aciklama ? ` · ${esc(k.aciklama)}` : ""}
      <span style="font-size:12px;color:var(--text2);"> · Talep: ${esc(_zaman(k.zaman))}</span></div>
    <div style="font-size:12px;color:var(--text2);margin:6px 0;">Onaylanınca rapor ${esc(tarihTR(k.donus_tarihi))} öncesinde biter; o günden itibaren vekil atanmaz.
      ${kalkacak.length ? `Bugün henüz başlamamış derslerin vekil ataması kaldırılır, vekillere giden bildirimler silinir ve iptal bildirilir: ${kalkacak.map((d) => `${d.lesson_number}. ders ${esc(d.class_id)} (${esc(d.substitute_teacher_ad || "?")})`).join(", ")}.` : ""}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <button class="btn btn-yesil btn-sm" data-id="${esc(iz.id)}" onclick="vekilIzinKarar(this.dataset.id, 'onay', this, 'kesme')">✔ Onayla</button>
      <input type="text" id="vizNot_${esc(iz.id)}" placeholder="Red notu (isteğe bağlı)" style="font-size:12px;max-width:220px;">
      <button class="btn btn-kirmizi btn-sm" data-id="${esc(iz.id)}" onclick="vekilIzinKarar(this.dataset.id, 'red', this, 'kesme')">✖ Reddet</button>
    </div></div>`;
}

window.vekilIzinKarar = async (izinId, karar, btn, tur = "izin") => {
  const iz = _izinler.find((x) => x.id === izinId && x.tip === tur);
  if (!iz) return;
  const soru = karar === "red"
    ? [tur === "kesme" ? "Yarıda Kesmeyi Reddet" : "İzni Reddet", `${iz.ogretmen_ad} — talep reddedilecek ve öğretmene bildirilecek.`, "Reddet", "btn-kirmizi"]
    : tur === "kesme"
      ? ["Yarıda Kesmeyi Onayla", `${iz.ogretmen_ad} ${tarihTR(iz.kesme_talebi?.donus_tarihi)} itibarıyla okulda olacak. Vekil atamaları kaldırılacak ve vekillere bildirilecek.`, "Onayla", "btn-yesil"]
      : ["İzni Onayla", `${iz.ogretmen_ad} — ${IZIN_TUR_AD[iz.tur] || ""}, ${_aralik(iz)}. Vekiller atanacak ve öğretmenlere bildirim gidecek.`, "Onayla", "btn-yesil"];
  if (!await sor(...soru)) return;
  const secimler = {};
  document.querySelectorAll(`#vekilIzinListesi .viz-sec[data-izin="${CSS.escape(izinId)}"]`).forEach((s) => (secimler[s.dataset.ders] = s.value));
  const not = document.getElementById("vizNot_" + izinId)?.value || "";
  btn.disabled = true;
  try {
    const { data } = await httpsCallable(functions, "ogretmenIzinKarar")({ izinId, karar, tur, secimler, not });
    mesajGoster("vekilIzinMesaj", data?.message || "Kaydedildi.", "basari");
    await Promise.all([_izinleriYukle(), _raporListesiYukle()]);
    _gecmisVekilYukle();
  } catch (err) {
    mesajGoster("vekilIzinMesaj", "Hata: " + err.message, "hata");
    btn.disabled = false;
  }
};

// ── RAPORLU ÖĞRETMENLER + BUGÜNKÜ VEKİL ATAMALARI ──
// Atama tablosu her zaman bugunun today_lessons kayitlarindan cizilir; sayfa
// yenilense de, baska menuye gecilse de, 07:00 otomatik atamalari dahil
// gorunur ve degistirilebilir.
let _raporlarCache = [];
let _bugunDersler = [];

async function _raporListesiYukle() {
  const container = document.getElementById("vekilRaporListesi");
  if (!container) return;
  if (!container.children.length || container.querySelector(".yukleniyor")) container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const bugun = bugunHesapla();
    const [snap, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "ogretmen_rapor"), where("bitis_tarihi", ">=", bugun))),
      getDocs(query(collection(db, "today_lessons"), where("date", "==", bugun))),
    ]);
    _raporlarCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.baslangic_tarihi || "").localeCompare(b.baslangic_tarihi || ""));
    _bugunDersler = dersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    _raporListesiRender();
  } catch (err) {
    container.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}

function _raporListesiRender() {
  const container = document.getElementById("vekilRaporListesi");
  if (!container) return;
  if (!_raporlarCache.length) {
    container.innerHTML = '<div class="bos-mesaj">Aktif veya yaklasan rapor yok.</div>';
    return;
  }
  // Sayfa acilisindaki `bugun` sabiti yerine guncel tarih: portal onceki
  // gunden acik kaldiysa bugun baslayan rapor "aktif degil" gorunuyordu.
  const simdi = bugunHesapla();
  const gosterilen = new Set();  // ayni ogretmenin iki raporu varsa tablo bir kez
  container.innerHTML = _raporlarCache.map((r) => {
    const aktifMi = r.baslangic_tarihi <= simdi && r.bitis_tarihi >= simdi;
    const pasifMetin = r.baslangic_tarihi > simdi
      ? `Henüz başlamadı (${esc(tarihTR(r.baslangic_tarihi))})`
      : "Rapor bitti";
    const tablo = aktifMi && !gosterilen.has(r.ogretmen_id) ? _atamaTablosu(r.ogretmen_id) : "";
    if (aktifMi) gosterilen.add(r.ogretmen_id);
    return `<div class="kart" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${esc(r.ogretmen_ad)}</strong>
          ${r.izin_id ? `<span class="rozet rozet-mavi" style="font-size:11px;">🏥 ${esc(IZIN_TUR_AD[r.izin_tur] || "İzin")} (öğretmen girdi)</span>` : ""}
          <div style="font-size:12px;color:var(--text2);">${esc(r.baslangic_tarihi)} — ${esc(r.bitis_tarihi)}${r.aciklama ? " · " + esc(r.aciklama) : ""}${r.aciklama_ek ? " · " + esc(r.aciklama_ek) : ""}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${aktifMi
            ? `<button class="btn btn-mavi btn-sm" onclick="vekilAta('${esc(r.ogretmen_id)}', this)">🔄 Vekilsizlere Ata</button>`
            : `<span class="rozet rozet-gri">${pasifMetin}</span>`}
          <button class="btn btn-kirmizi btn-sm" onclick="vekilRaporSil('${r.id}')">Sil</button>
        </div>
      </div>
      <div id="vekilSonuc_${esc(r.ogretmen_id)}" style="margin-top:8px;">${tablo}</div>
    </div>`;
  }).join("");
}

function _atamaTablosu(ogretmenId) {
  const dersler = _bugunDersler.filter((d) => d.teacher_id === ogretmenId).sort((a, b) => a.lesson_number - b.lesson_number);
  if (!dersler.length) return '<div style="font-size:13px;color:var(--text2);">Bugün için dersi bulunamadı (dersler henüz oluşturulmamış olabilir — Manuel Giriş sekmesinden oluşturabilirsiniz).</div>';
  const secenekler = _ogretmenOptionsHtml(ogretmenId);
  return `<div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px;">Bugünkü vekil atamaları</div>
    <div style="overflow-x:auto;"><table style="width:100%;font-size:13px;"><tbody>
    ${dersler.map((d) => `<tr>
      <td style="padding:4px 6px;white-space:nowrap;">${d.lesson_number}. ders</td>
      <td style="padding:4px 6px;">${esc(d.class_id)} ${esc(d.lesson_name || "")}</td>
      <td style="padding:4px 6px;">${d.substitute_teacher_id
        ? `${TIER_ETIKET[d.substitute_tier] || ""} <strong>${esc(d.substitute_teacher_ad || "")}</strong>`
        : '<span style="color:#ea4335;">⚠️ Vekil yok</span>'}</td>
      <td style="padding:4px 6px;white-space:nowrap;"><button class="btn btn-gri btn-sm" onclick="vekilYenidenAta('${esc(ogretmenId)}','${esc(d.id)}', this)">${d.substitute_teacher_id ? "Otomatik Değiştir" : "Otomatik Ata"}</button></td>
      <td style="padding:4px 6px;white-space:nowrap;">
        <select id="vmSec_${esc(ogretmenId)}_${esc(d.id)}" style="font-size:12px;max-width:140px;">${secenekler}</select>
        <button class="btn btn-mavi btn-sm" onclick="vekilElleAta('${esc(ogretmenId)}','${esc(d.id)}')">Ata</button>
      </td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

window.vekilRaporKaydet = async function () {
  const secim = document.getElementById("vekilOgretmenSecim");
  const ogretmenId = secim.value;
  const ogretmenAd = secim.selectedOptions[0]?.textContent || "";
  const bas = document.getElementById("vekilRaporBaslangic").value;
  const bit = document.getElementById("vekilRaporBitis").value;
  const aciklama = document.getElementById("vekilRaporAciklama").value.trim();

  if (!ogretmenId) { mesajGoster("vekilRaporMesaj", "Ogretmen secin.", "hata"); return; }
  if (!bas || !bit || bit < bas) { mesajGoster("vekilRaporMesaj", "Gecerli tarih araligi girin.", "hata"); return; }

  try {
    await addDoc(collection(db, "ogretmen_rapor"), {
      ogretmen_id: ogretmenId,
      ogretmen_ad: ogretmenAd,
      baslangic_tarihi: bas,
      bitis_tarihi: bit,
      aciklama,
      olusturulma: serverTimestamp(),
    });
    mesajGoster("vekilRaporMesaj", "Rapor eklendi.", "basari");
    document.getElementById("vekilRaporAciklama").value = "";
    await _raporListesiYukle();
  } catch (err) {
    mesajGoster("vekilRaporMesaj", "Hata: " + err.message, "hata");
  }
};

window.vekilRaporSil = async function (raporId) {
  if (!await sor("Raporu Sil", "Bu rapor kaydi silinecek.", "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "ogretmen_rapor", raporId));
  await _raporListesiYukle();
};

function _sonucMesaji(ogretmenId, metin, hata) {
  const el = document.getElementById("vekilSonuc_" + ogretmenId);
  if (!el) return;
  const kutu = document.createElement("div");
  kutu.style.cssText = `font-size:13px;margin-top:6px;color:${hata ? "#ea4335" : "var(--text2)"};`;
  kutu.textContent = metin;
  el.appendChild(kutu);
}

window.vekilAta = async function (ogretmenId, btn) {
  if (btn) btn.disabled = true;
  try {
    const { data } = await httpsCallable(functions, "raporluIcinVekilAta")({ ogretmenId });
    await _raporListesiYukle();
    _gecmisVekilYukle();
    if (!data?.success) _sonucMesaji(ogretmenId, data?.message || "Atama yapilamadi.", true);
    else if (!(data.sonuclar || []).length) _sonucMesaji(ogretmenId, "Vekilsiz ders kalmadı.");
    else {
      const yok = data.sonuclar.filter((s) => !s.atandi).length;
      if (yok) _sonucMesaji(ogretmenId, `${yok} ders için uygun öğretmen bulunamadı; elle atayın.`, true);
    }
  } catch (err) {
    _sonucMesaji(ogretmenId, "Hata: " + err.message, true);
  }
  if (btn) btn.disabled = false;
};

window.vekilYenidenAta = async function (ogretmenId, dersId, btn) {
  if (btn) btn.disabled = true;
  try {
    const { data } = await httpsCallable(functions, "raporluIcinVekilAta")({ dersIdListesi: [dersId] });
    await _raporListesiYukle();
    _gecmisVekilYukle();
    if (!data?.success) _sonucMesaji(ogretmenId, data?.message || "Atama yapilamadi.", true);
    else if (data.sonuclar?.some((s) => !s.atandi)) _sonucMesaji(ogretmenId, "Bu saatte uygun öğretmen bulunamadı; elle atayın.", true);
  } catch (err) {
    _sonucMesaji(ogretmenId, "Hata: " + err.message, true);
    if (btn) btn.disabled = false;
  }
};

// Manuel atama: admin, otomatik oneriyi (nobetci/diger) beklemeden istedigi
// herhangi bir ogretmeni dogrudan secip atayabilir. today_lessons yazma
// kurali zaten isLoggedIn() oldugu icin dogrudan istemciden yaziliyor,
// ayri bir Cloud Function gerekmiyor. Vekile bildirim vekilAtamaDegisti'nden.
window.vekilElleAta = async function (ogretmenId, dersId) {
  const sec = document.getElementById(`vmSec_${ogretmenId}_${dersId}`);
  const secilenId = sec?.value;
  if (!secilenId) { _sonucMesaji(ogretmenId, "Önce bir öğretmen seçin.", true); return; }
  const secilenAd = state.ogretmenler.find((o) => o.id === secilenId)?.ad || "";
  const raporluAd = _raporlarCache.find((r) => r.ogretmen_id === ogretmenId)?.ogretmen_ad || "";
  try {
    await updateDoc(doc(db, "today_lessons", dersId), {
      substitute_teacher_id: secilenId,
      substitute_teacher_ad: secilenAd,
      substitute_for_teacher_id: ogretmenId,
      substitute_for_teacher_ad: raporluAd,
      substitute_tier: "manuel",
      substitute_assigned_at: serverTimestamp(),
    });
    await _raporListesiYukle();
    _gecmisVekilYukle();
  } catch (err) {
    _sonucMesaji(ogretmenId, "Hata: " + err.message, true);
  }
};

// ── GEÇMİŞ VEKİL DERSLERİ (Raporlar > Vekillik ile ayni kaynak: vekil_dersler) ──
// Sayilan: derse girdigi kaydedilmis dersler. Vekil Atama'dan atanip henuz
// onaylanmamis dersler "onay bekliyor" olarak ayrica gosterilir, toplama girmez.
function _gecmisKayitId(tarih, sinif, dersNo) {
  return `${tarih}_${String(sinif).replace(/[\/\s.#\[\]]/g, "-")}_${dersNo}`;
}

async function _gecmisVekilYukle() {
  const container = document.getElementById("vekilGecmisIcerik");
  const bas = document.getElementById("vekilGecmisBaslangic")?.value;
  const bit = document.getElementById("vekilGecmisBitis")?.value;
  if (!container || !bas || !bit) return;
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  let kayitSnap, dersSnap;
  try {
    [kayitSnap, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "vekil_dersler"), where("tarih", ">=", bas), where("tarih", "<=", bit))),
      getDocs(query(collection(db, "today_lessons"), where("date", ">=", bas), where("date", "<=", bit))),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="bos-mesaj">Yuklenemedi: ${esc(err.message)}</div>`;
    return;
  }

  const vekilStat = {};
  const ekle = (id, ad) => (vekilStat[id] ||= { ad: ad || id, kayitlar: [], bekleyen: [] });
  const kayitIdleri = new Set();
  let toplamDers = 0;
  kayitSnap.forEach((d) => {
    const v = d.data();
    kayitIdleri.add(d.id);
    toplamDers++;
    ekle(v.vekil_ogretmen_id, v.vekil_ogretmen_ad).kayitlar.push({
      tarih: v.tarih, class_id: v.sinif, lesson_number: v.ders_no,
      lesson_name: v.ders_adi || "-", icin: v.asil_ogretmen_ad || "?",
    });
  });

  let bekleyenToplam = 0;
  dersSnap.forEach((d) => {
    const v = d.data();
    if (!v.substitute_teacher_id || kayitIdleri.has(_gecmisKayitId(v.date, v.class_id, v.lesson_number))) return;
    bekleyenToplam++;
    ekle(v.substitute_teacher_id, v.substitute_teacher_ad).bekleyen.push({
      tarih: v.date, class_id: v.class_id, lesson_number: v.lesson_number,
      lesson_name: v.lesson_name || "-", icin: v.substitute_for_teacher_ad || "?",
    });
  });

  if (!toplamDers && !bekleyenToplam) {
    container.innerHTML = '<div class="bos-mesaj">Bu tarih araliginda vekillik kaydi yok.</div>';
    return;
  }

  const sirali = Object.values(vekilStat).sort(
    (a, b) => b.kayitlar.length - a.kayitlar.length || a.ad.localeCompare(b.ad, "tr"),
  );
  const satir = (k) => `${k.tarih} — ${esc(k.class_id)} ${esc(k.lesson_name)} (${k.lesson_number}. ders, ${esc(k.icin)} yerine)`;
  const sirala = (a, b) => a.tarih.localeCompare(b.tarih) || a.lesson_number - b.lesson_number;

  let html = `<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Derse girdiği kaydedilmiş ${toplamDers} vekillik dersi — ${sirali.filter((o) => o.kayitlar.length).length} farkli ogretmen${bekleyenToplam ? ` · <span style="color:#e65100;">⏳ ${bekleyenToplam} atama onay bekliyor (sayılmaz)</span>` : ""}</div>`;
  html += '<table style="width:100%;font-size:13px;"><tbody>';
  sirali.forEach((o) => {
    const detay = [
      ...o.kayitlar.sort(sirala).map(satir),
      ...o.bekleyen.sort(sirala).map((k) => `<span style="color:#e65100;">⏳ ${satir(k)} — onay bekliyor</span>`),
    ].join("<br>");
    html += `<tr>
      <td style="padding:4px 6px;white-space:nowrap;"><strong>${esc(o.ad)}</strong></td>
      <td style="padding:4px 6px;white-space:nowrap;"><strong style="color:var(--mavi)">${o.kayitlar.length}</strong></td>
      <td style="padding:4px 6px;"><small style="color:var(--text2);">${detay}</small></td>
    </tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}
window.vekilGecmisYukle = _gecmisVekilYukle;
