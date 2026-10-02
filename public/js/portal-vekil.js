import {
  db, functions, bugun, bugunHesapla,
  getDocs, addDoc, deleteDoc, updateDoc,
  collection, query, where, doc, serverTimestamp, httpsCallable,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";

// ── VEKİL ATAMA SAYFASI ──
export function vekilAtamaSayfasiBaslat() {
  _ogretmenSecimDoldur();
  _raporListesiYukle();

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

function _ogretmenSecimDoldur() {
  const select = document.getElementById("vekilOgretmenSecim");
  if (!select) return;
  select.innerHTML = '<option value="">Ogretmen secin...</option>';
  [...state.ogretmenler]
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .forEach((o) => (select.innerHTML += `<option value="${o.id}">${esc(o.ad)}</option>`));
}

let _raporlarCache = [];

async function _raporListesiYukle() {
  const container = document.getElementById("vekilRaporListesi");
  if (!container) return;
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(query(collection(db, "ogretmen_rapor"), where("bitis_tarihi", ">=", bugunHesapla())));
  _raporlarCache = [];
  snap.forEach((d) => _raporlarCache.push({ id: d.id, ...d.data() }));
  _raporlarCache.sort((a, b) => (a.baslangic_tarihi || "").localeCompare(b.baslangic_tarihi || ""));
  _raporListesiRender();
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
  const tarihTR = (t) => String(t || "").split("-").reverse().join(".");
  let html = "";
  _raporlarCache.forEach((r) => {
    const aktifMi = r.baslangic_tarihi <= simdi && r.bitis_tarihi >= simdi;
    const pasifMetin = r.baslangic_tarihi > simdi
      ? `Henüz başlamadı (${esc(tarihTR(r.baslangic_tarihi))})`
      : "Rapor bitti";
    html += `<div class="kart" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${esc(r.ogretmen_ad)}</strong>
          <div style="font-size:12px;color:var(--text2);">${esc(r.baslangic_tarihi)} — ${esc(r.bitis_tarihi)}${r.aciklama ? " · " + esc(r.aciklama) : ""}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${aktifMi
            ? `<button class="btn btn-mavi btn-sm" onclick="vekilAta('${esc(r.ogretmen_id)}')">🔄 Vekil Ata</button>`
            : `<span class="rozet rozet-gri">${pasifMetin}</span>`}
          <button class="btn btn-kirmizi btn-sm" onclick="vekilRaporSil('${r.id}')">Sil</button>
        </div>
      </div>
      <div id="vekilSonuc_${esc(r.ogretmen_id)}" style="margin-top:8px;"></div>
    </div>`;
  });
  container.innerHTML = html;
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

const TIER_ETIKET = { nobetci: "🛡 Nöbetçi", diger: "👤 Diğer", manuel: "✋ Elle" };

// Her raporlu öğretmen için en son gösterilen sonuç satırlarını (dersId bazında)
// hafızada tutar; "Vekil Ata" / "Değiştir" / manuel atama birbirinin üstüne
// yazmadan aynı tabloyu güncelleyebilsin diye.
const _sonEkranSonuclari = {};

window.vekilAta = async function (ogretmenId) {
  const sonucEl = document.getElementById("vekilSonuc_" + ogretmenId);
  if (sonucEl) sonucEl.innerHTML = '<span style="color:#1a73e8;font-size:13px;">Atama yapiliyor...</span>';
  try {
    const fn = httpsCallable(functions, "raporluIcinVekilAta");
    const { data } = await fn({ ogretmenId });
    _sonucGuncelle(ogretmenId, data);
    _gecmisVekilYukle();
  } catch (err) {
    if (sonucEl) sonucEl.innerHTML = `<span style="color:#ea4335;font-size:13px;">Hata: ${esc(err.message)}</span>`;
  }
};

window.vekilYenidenAta = async function (ogretmenId, dersId) {
  try {
    const fn = httpsCallable(functions, "raporluIcinVekilAta");
    const { data } = await fn({ dersIdListesi: [dersId] });
    if (!data?.success) { alert(data?.message || "Atama yapilamadi."); return; }
    _sonucGuncelle(ogretmenId, data);
    _gecmisVekilYukle();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// Manuel atama: admin, otomatik oneriyi (nobetci/diger) beklemeden istedigi
// herhangi bir ogretmeni dogrudan secip atayabilir. today_lessons yazma
// kurali zaten isLoggedIn() oldugu icin dogrudan istemciden yaziliyor,
// ayri bir Cloud Function gerekmiyor.
window.vekilElleAta = async function (ogretmenId, dersId) {
  const sec = document.getElementById(`vmSec_${ogretmenId}_${dersId}`);
  const secilenId = sec?.value;
  if (!secilenId) { alert("Once bir ogretmen secin."); return; }
  const secilenAd = state.ogretmenler.find((o) => o.id === secilenId)?.ad || "";
  const raporluAd = _raporlarCache.find((r) => r.ogretmen_id === ogretmenId)?.ogretmen_ad || "";
  try {
    await updateDoc(doc(db, "today_lessons", dersId), {
      substitute_teacher_id: secilenId,
      substitute_teacher_ad: secilenAd,
      substitute_for_teacher_id: ogretmenId,
      substitute_for_teacher_ad: raporluAd,
      substitute_assigned_at: serverTimestamp(),
    });
    const mevcut = _sonEkranSonuclari[ogretmenId] || [];
    const girdi = mevcut.find((s) => s.dersId === dersId);
    if (girdi) {
      girdi.atandi = true;
      girdi.tier = "manuel";
      girdi.vekilId = secilenId;
      girdi.vekilAd = secilenAd;
    }
    _sonEkranSonuclari[ogretmenId] = mevcut;
    _sonucTabloCiz(ogretmenId);
    _gecmisVekilYukle();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// Callable'dan gelen sonucu, o ogretmen icin daha once gosterilmis satirlarla
// birlestirir (tam degistirmez) — cunku "Vekil Ata" tekrar calistirildiginda
// veya tek bir ders icin "Degistir" yapildiginda backend sadece o an islenen
// dersleri dondurur, daha once basariyla atanmis diger satirlari degil.
function _sonucGuncelle(ogretmenId, data) {
  const sonucEl = document.getElementById("vekilSonuc_" + ogretmenId);
  if (!sonucEl) return;
  if (!data?.success) {
    sonucEl.innerHTML = `<div style="font-size:13px;color:#ea4335;">${esc(data?.message || "Atama yapilamadi.")}</div>`;
    return;
  }
  const mevcut = _sonEkranSonuclari[ogretmenId] || [];
  (data.sonuclar || []).forEach((yeni) => {
    const idx = mevcut.findIndex((s) => s.dersId === yeni.dersId);
    if (idx >= 0) mevcut[idx] = yeni; else mevcut.push(yeni);
  });
  _sonEkranSonuclari[ogretmenId] = mevcut;

  if (!mevcut.length) {
    sonucEl.innerHTML = `<div style="font-size:13px;color:var(--text2);">${esc(data.message || "Atanacak ders bulunamadi.")}</div>`;
    return;
  }
  _sonucTabloCiz(ogretmenId);
}

function _ogretmenOptionsHtml(haricId) {
  return [...state.ogretmenler]
    .filter((o) => o.id !== haricId)
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .map((o) => `<option value="${o.id}">${esc(o.ad)}</option>`)
    .join("");
}

function _sonucTabloCiz(ogretmenId) {
  const sonucEl = document.getElementById("vekilSonuc_" + ogretmenId);
  const sonuclar = _sonEkranSonuclari[ogretmenId];
  if (!sonucEl || !sonuclar?.length) return;
  const ogretmenSecenekleri = _ogretmenOptionsHtml(ogretmenId);
  let html = '<table style="width:100%;font-size:13px;"><tbody>';
  sonuclar
    .slice()
    .sort((a, b) => a.lessonNumber - b.lessonNumber)
    .forEach((s) => {
      html += `<tr>
        <td style="padding:4px 6px;white-space:nowrap;">${s.lessonNumber}. ders</td>
        <td style="padding:4px 6px;">${esc(s.classId)} ${esc(s.lessonName || "")}</td>
        <td style="padding:4px 6px;">${s.atandi
          ? `${TIER_ETIKET[s.tier] || ""} <strong>${esc(s.vekilAd)}</strong>`
          : '<span style="color:#ea4335;">⚠️ Uygun ogretmen yok</span>'}</td>
        <td style="padding:4px 6px;white-space:nowrap;">${s.atandi ? `<button class="btn btn-gri btn-sm" onclick="vekilYenidenAta('${esc(ogretmenId)}','${esc(s.dersId)}')">Otomatik Degistir</button>` : ""}</td>
        <td style="padding:4px 6px;white-space:nowrap;">
          <select id="vmSec_${esc(ogretmenId)}_${esc(s.dersId)}" style="font-size:12px;max-width:140px;">${ogretmenSecenekleri}</select>
          <button class="btn btn-mavi btn-sm" onclick="vekilElleAta('${esc(ogretmenId)}','${esc(s.dersId)}')">Ata</button>
        </td>
      </tr>`;
    });
  html += "</tbody></table>";
  sonucEl.innerHTML = html;
}

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
