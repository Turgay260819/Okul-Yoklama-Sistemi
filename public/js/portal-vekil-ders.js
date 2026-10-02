import {
  db, auth, bugun, bugunHesapla,
  getDocs, getDoc, setDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor, normalizeGun, gunAdiGetir } from "./portal-utils.js";

// ── VEKİL DERS KAYITLARI (ücret) ──
// vekil_dersler: "kim hangi derse girdi" sorusunun tek kaydi. Belge kimligi
// tarih_sinif_saat oldugu icin bir sinif-saate tek kayit acilir (ilk giren
// alir; firestore.rules ogretmenin mevcut kaydin ustune yazmasina izin vermez).
// Ogretmen bugune ve bir onceki is gunune kendi adina yazar; daha eskisini
// yonetim girer (firestore.rules ogretmenTarihi ile ayni sinir).

const KAYNAK_ETIKET = { sistem_onay: "Atama onayı", ogretmen: "Öğretmen girdi", admin: "İdare girdi" };

export function kayitId(tarih, sinif, dersNo) {
  return `${tarih}_${String(sinif).replace(/[\/\s.#\[\]]/g, "-")}_${dersNo}`;
}

function ogretmenAd(id) {
  return state.ogretmenler.find((o) => o.id === id)?.ad || "?";
}

function ayBasi(tarih) {
  return tarih.slice(0, 8) + "01";
}

function tarihGoster(t) {
  const [y, m, d] = String(t || "").split("-");
  return d ? `${d}.${m}.${y}` : t;
}

// Ders + asıl öğretmen + vekil bilgisinden vekil_dersler belgesini kurar.
function kayitVerisi(ders, vekilId, kaynak) {
  return {
    tarih: ders.date,
    ders_no: ders.lesson_number,
    sinif: ders.class_id,
    ders_adi: ders.lesson_name || "",
    asil_ogretmen_id: ders.teacher_id || "",
    asil_ogretmen_ad: ders.teacher_id ? ogretmenAd(ders.teacher_id) : "",
    vekil_ogretmen_id: vekilId,
    vekil_ogretmen_ad: ogretmenAd(vekilId),
    kaynak,
    today_lesson_id: ders.id || null,
    olusturan_uid: auth.currentUser?.uid || null,
    olusturma: serverTimestamp(),
  };
}

// Kayit zaten varsa kimin girdigini soyler; yoksa yazar. Yaris durumunda
// kural reddeder (update izni yok) — o da ayni mesaja cevrilir.
export async function kayitOlustur(ders, vekilId, kaynak) {
  const id = kayitId(ders.date, ders.class_id, ders.lesson_number);
  const ref = doc(db, "vekil_dersler", id);
  const mevcut = await getDoc(ref);
  if (mevcut.exists()) {
    throw new Error(`Bu ders zaten ${mevcut.data().vekil_ogretmen_ad || "başka bir öğretmen"} tarafından girilmiş.`);
  }
  try {
    await setDoc(ref, kayitVerisi(ders, vekilId, kaynak));
  } catch (err) {
    const tekrar = await getDoc(ref).catch(() => null);
    if (tekrar?.exists()) throw new Error(`Bu ders zaten ${tekrar.data().vekil_ogretmen_ad || "başka bir öğretmen"} tarafından girilmiş.`);
    throw err;
  }
}

// ═══════════════ ÖĞRETMEN: VEKİL DERSLERİM ═══════════════

const GUN_ADLARI = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

// Bir onceki is gunu: Pzt -> Cuma, Paz -> Cuma, Cmt -> Cuma, digerleri -> dun.
// firestore.rules oncekiIsGunuTR() ile ayni mantik; degisirse ikisi birlikte.
export function oncekiIsGunu(tarih) {
  const d = new Date(tarih + "T12:00:00");
  const gun = d.getDay();
  d.setDate(d.getDate() - (gun === 1 ? 3 : gun === 0 ? 2 : 1));
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function gunEtiketi(tarih) {
  const [, m, g] = tarih.split("-");
  return `${g}.${m} ${GUN_ADLARI[new Date(tarih + "T12:00:00").getDay()]}`;
}

let _seciliTarih = null;   // null = bugun
let _bugunDersler = [];    // secili gunun dersleri
let _bugunKayitlar = {};   // secili gunun vekil_dersler kayitlari

window.vekilGunSec = (secim) => {
  _seciliTarih = secim === "onceki" ? oncekiIsGunu(bugunHesapla()) : null;
  vekilDerslerimYukle();
};

export async function vekilDerslerimYukle() {
  const kok = document.getElementById("vekilDerslerimIcerik");
  if (!kok) return;
  const ben = state.ogretmenDoc;
  if (!ben) { kok.innerHTML = '<div class="bos-mesaj">Öğretmen kaydınız bulunamadı.</div>'; return; }
  kok.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const bugunTarih = bugunHesapla();
  const onceki = oncekiIsGunu(bugunTarih);
  if (_seciliTarih && _seciliTarih !== onceki) _seciliTarih = null; // gun degistiyse
  const tarih = _seciliTarih || bugunTarih;

  try {
    const [dersSnap, kayitSnap, benimSnap] = await Promise.all([
      getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih))),
      getDocs(query(collection(db, "vekil_dersler"), where("tarih", "==", tarih))),
      getDocs(query(collection(db, "vekil_dersler"), where("vekil_ogretmen_id", "==", ben.id))),
    ]);
    _bugunDersler = [];
    dersSnap.forEach((d) => _bugunDersler.push({ id: d.id, ...d.data() }));
    _bugunKayitlar = {};
    kayitSnap.forEach((d) => (_bugunKayitlar[d.id] = d.data()));
    const benimKayitlar = [];
    benimSnap.forEach((d) => benimKayitlar.push({ id: d.id, ...d.data() }));

    const bugunMu = tarih === bugunTarih;
    kok.innerHTML =
      _gunSeciciHtml(bugunTarih, onceki, bugunMu) +
      _atananlarHtml(ben, tarih, bugunMu) +
      _elleEkleHtml(tarih, bugunMu) +
      _buAyHtml(benimKayitlar.filter((k) => k.tarih >= ayBasi(bugunTarih) && k.tarih <= bugunTarih));
    _saatSecenekleriniDoldur();
  } catch (err) {
    kok.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.vekilDerslerimYukle = vekilDerslerimYukle;

function _gunSeciciHtml(bugunTarih, onceki, bugunMu) {
  return `<div class="sekme-bar" style="margin-bottom:12px;">
    <button class="sekme-btn${bugunMu ? " aktif" : ""}" onclick="vekilGunSec('bugun')">Bugün (${esc(gunEtiketi(bugunTarih))})</button>
    <button class="sekme-btn${bugunMu ? "" : " aktif"}" onclick="vekilGunSec('onceki')">Önceki iş günü (${esc(gunEtiketi(onceki))})</button>
  </div>`;
}

function _atananlarHtml(ben, tarih, bugunMu) {
  const atananlar = _bugunDersler
    .filter((d) => d.substitute_teacher_id === ben.id)
    .sort((a, b) => a.lesson_number - b.lesson_number);
  let html = `<div class="kart">
    <div class="kart-baslik">${bugunMu ? "Bugün" : esc(gunEtiketi(tarih))} Size Atanan Vekil Dersler</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Ücret, sadece burada "Derse girdim" ile onayladığınız veya aşağıdan eklediğiniz dersler için ödenir. Kayıt bugün ve bir önceki iş günü için yapılabilir; daha eski tarihler için idareye başvurun.</p>`;
  if (!atananlar.length) {
    html += `<div class="bos-mesaj">${bugunMu ? "Bugün" : "Bu gün"} size atanmış vekil ders yok.</div></div>`;
    return html;
  }
  html += atananlar.map((d) => {
    const id = kayitId(d.date, d.class_id, d.lesson_number);
    const kayit = _bugunKayitlar[id];
    let sag;
    if (!kayit) {
      sag = `<button class="btn btn-yesil btn-sm" data-ders="${esc(d.id)}" onclick="vekilDerseGirdim(this)">Derse girdim</button>`;
    } else if (kayit.vekil_ogretmen_id === ben.id) {
      sag = `<span class="rozet rozet-yesil">✓ Kaydedildi</span>
        <button class="btn btn-gri btn-sm" data-id="${esc(id)}" onclick="vekilKaydimiGeriAl(this)">Geri al</button>`;
    } else {
      sag = `<span class="rozet rozet-turuncu">${esc(kayit.vekil_ogretmen_ad)} girmiş</span>`;
    }
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border);">
      <div><strong>${d.lesson_number}. Ders</strong> — ${esc(d.class_id)} ${esc(d.lesson_name || "")}
        <div style="font-size:12px;color:var(--text2);">${esc(d.substitute_for_teacher_ad || ogretmenAd(d.teacher_id))} yerine</div></div>
      <div style="display:flex;gap:6px;align-items:center;">${sag}</div>
    </div>`;
  }).join("");
  return html + '<div class="mesaj" id="vekilAtananMesaj" style="margin-top:8px;"></div></div>';
}

function _elleEkleHtml(tarih, bugunMu) {
  return `<div class="kart">
    <div class="kart-baslik">Atanmamış Bir Derse Girdim${bugunMu ? "" : ` — ${esc(gunEtiketi(tarih))}`}</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Size sistemden atanmadığı halde ${bugunMu ? "bugün" : esc(gunEtiketi(tarih)) + " günü"} başka bir öğretmenin yerine derse girdiyseniz buradan ekleyin.</p>
    <div class="form-grid">
      <div class="form-group"><label>Ders Saati</label>
        <select id="vekilElleSaat" onchange="vekilElleSaatSecildi()"><option value="">Seçin</option></select></div>
      <div class="form-group"><label>Girdiğiniz Ders</label>
        <select id="vekilElleDers"><option value="">Önce saat seçin</option></select></div>
    </div>
    <button class="btn btn-mavi" onclick="vekilElleKaydet()">Kaydet</button>
    <div class="mesaj" id="vekilElleMesaj" style="margin-top:8px;"></div>
  </div>`;
}

function _buAyHtml(kayitlar) {
  kayitlar.sort((a, b) => b.tarih.localeCompare(a.tarih) || a.ders_no - b.ders_no);
  let html = `<div class="kart">
    <div class="kart-baslik">Bu Ayki Vekil Derslerim <span class="rozet rozet-mavi">${kayitlar.length} ders</span></div>`;
  if (!kayitlar.length) return html + '<div class="bos-mesaj">Bu ay kayıtlı vekil dersiniz yok.</div></div>';
  html += '<div style="overflow-x:auto;"><table><thead><tr><th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Yerine</th></tr></thead><tbody>';
  html += kayitlar.map((k) => `<tr>
    <td>${esc(tarihGoster(k.tarih))}</td><td>${k.ders_no}. ders</td>
    <td>${esc(k.sinif)} ${esc(k.ders_adi)}</td><td>${esc(k.asil_ogretmen_ad || "-")}</td></tr>`).join("");
  return html + "</tbody></table></div></div>";
}

function _saatSecenekleriniDoldur() {
  const sel = document.getElementById("vekilElleSaat");
  if (!sel) return;
  const saatler = [...new Set(_bugunDersler.map((d) => d.lesson_number))].sort((a, b) => a - b);
  sel.innerHTML = '<option value="">Seçin</option>' + saatler.map((s) => `<option value="${s}">${s}. Ders</option>`).join("");
  if (!saatler.length) sel.innerHTML = '<option value="">Bu gün için ders programı yok</option>';
}

window.vekilElleSaatSecildi = () => {
  const saat = Number(document.getElementById("vekilElleSaat").value);
  const sel = document.getElementById("vekilElleDers");
  if (!saat) { sel.innerHTML = '<option value="">Önce saat seçin</option>'; return; }
  const benId = state.ogretmenDoc?.id;
  const adaylar = _bugunDersler
    .filter((d) => d.lesson_number === saat && d.teacher_id !== benId)
    .filter((d) => !_bugunKayitlar[kayitId(d.date, d.class_id, d.lesson_number)])
    .sort((a, b) => String(a.class_id).localeCompare(String(b.class_id), "tr"));
  sel.innerHTML = adaylar.length
    ? '<option value="">Seçin</option>' + adaylar.map((d) =>
        `<option value="${esc(d.id)}">${esc(d.class_id)} — ${esc(d.lesson_name || "")} — ${esc(ogretmenAd(d.teacher_id))}${d.substitute_teacher_id ? ` (atanan: ${esc(d.substitute_teacher_ad || "")})` : ""}</option>`).join("")
    : '<option value="">Bu saatte kaydedilebilecek ders yok</option>';
};

window.vekilElleKaydet = async () => {
  const dersId = document.getElementById("vekilElleDers").value;
  const ders = _bugunDersler.find((d) => d.id === dersId);
  if (!ders) { mesajGoster("vekilElleMesaj", "Ders saati ve dersi seçin.", "hata"); return; }
  try {
    await kayitOlustur(ders, state.ogretmenDoc.id, "ogretmen");
    await vekilDerslerimYukle();
    mesajGoster("vekilElleMesaj", "Kaydedildi.", "basari");
  } catch (err) {
    mesajGoster("vekilElleMesaj", err.message, "hata");
  }
};

window.vekilDerseGirdim = async (btn) => {
  const ders = _bugunDersler.find((d) => d.id === btn.dataset.ders);
  if (!ders) return;
  btn.disabled = true;
  try {
    await kayitOlustur(ders, state.ogretmenDoc.id, "sistem_onay");
    await vekilDerslerimYukle();
  } catch (err) {
    btn.disabled = false;
    mesajGoster("vekilAtananMesaj", err.message, "hata");
  }
};

window.vekilKaydimiGeriAl = async (btn) => {
  if (!await sor("Kaydı Geri Al", "Bu vekil ders kaydı silinecek.", "Geri al", "btn-kirmizi")) return;
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "vekil_dersler", btn.dataset.id));
    await vekilDerslerimYukle();
  } catch (err) {
    btn.disabled = false;
    mesajGoster("vekilAtananMesaj", "Hata: " + err.message, "hata");
  }
};

// ═══════════════ ADMİN: VEKİL DERS KAYITLARI ═══════════════

let _adminKayitlar = [];
let _adminEkleDersler = [];

export function vekilDerslerAdminYukle() {
  const bas = document.getElementById("vdBaslangic");
  const bit = document.getElementById("vdBitis");
  if (bas && !bas.value) bas.value = ayBasi(bugun);
  if (bit && !bit.value) bit.value = bugun;
  const ekleTarih = document.getElementById("vdEkleTarih");
  if (ekleTarih && !ekleTarih.value) ekleTarih.value = bugun;

  const ogrOptions = [...state.ogretmenler]
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .map((o) => `<option value="${esc(o.id)}">${esc(o.ad)}</option>`).join("");
  const filtre = document.getElementById("vdOgretmen");
  if (filtre && filtre.options.length <= 1) filtre.innerHTML = '<option value="">Tüm öğretmenler</option>' + ogrOptions;
  const vekilSec = document.getElementById("vdEkleVekil");
  if (vekilSec && vekilSec.options.length <= 1) vekilSec.innerHTML = '<option value="">Seçin</option>' + ogrOptions;

  vekilDerslerListele();
}
window.vekilDerslerAdminYukle = vekilDerslerAdminYukle;

window.vekilDerslerListele = async function vekilDerslerListele() {
  const bas = document.getElementById("vdBaslangic").value;
  const bit = document.getElementById("vdBitis").value;
  const ogrFiltre = document.getElementById("vdOgretmen").value;
  const ozetEl = document.getElementById("vdOzet");
  const listeEl = document.getElementById("vdListe");
  const onaysizEl = document.getElementById("vdOnaysiz");
  if (!bas || !bit || bit < bas) { ozetEl.innerHTML = '<div class="bos-mesaj">Geçerli bir tarih aralığı seçin.</div>'; return; }
  [ozetEl, listeEl, onaysizEl].forEach((el) => (el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>'));

  try {
    const [kayitSnap, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "vekil_dersler"), where("tarih", ">=", bas), where("tarih", "<=", bit))),
      getDocs(query(collection(db, "today_lessons"), where("date", ">=", bas), where("date", "<=", bit))),
    ]);
    const kayitIdleri = new Set();
    _adminKayitlar = [];
    kayitSnap.forEach((d) => {
      kayitIdleri.add(d.id);
      const k = { id: d.id, ...d.data() };
      if (!ogrFiltre || k.vekil_ogretmen_id === ogrFiltre) _adminKayitlar.push(k);
    });
    _adminKayitlar.sort((a, b) => a.tarih.localeCompare(b.tarih) || a.ders_no - b.ders_no);

    const onaysizlar = [];
    dersSnap.forEach((d) => {
      const v = { id: d.id, ...d.data() };
      if (!v.substitute_teacher_id) return;
      if (ogrFiltre && v.substitute_teacher_id !== ogrFiltre) return;
      if (kayitIdleri.has(kayitId(v.date, v.class_id, v.lesson_number))) return;
      onaysizlar.push(v);
    });
    onaysizlar.sort((a, b) => a.date.localeCompare(b.date) || a.lesson_number - b.lesson_number);
    window._vdOnaysizlar = onaysizlar;

    _ozetCiz(ozetEl, bas, bit);
    _listeCiz(listeEl);
    _onaysizCiz(onaysizEl, onaysizlar);
  } catch (err) {
    ozetEl.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
    listeEl.innerHTML = onaysizEl.innerHTML = "";
  }
};

function _ozetCiz(el, bas, bit) {
  const sayac = {};
  _adminKayitlar.forEach((k) => {
    if (!sayac[k.vekil_ogretmen_id]) sayac[k.vekil_ogretmen_id] = { ad: k.vekil_ogretmen_ad, sayi: 0 };
    sayac[k.vekil_ogretmen_id].sayi++;
  });
  const satirlar = Object.values(sayac).sort((a, b) => b.sayi - a.sayi || a.ad.localeCompare(b.ad, "tr"));
  if (!satirlar.length) { el.innerHTML = '<div class="bos-mesaj">Bu aralıkta vekil ders kaydı yok.</div>'; return; }
  el.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">${esc(tarihGoster(bas))} – ${esc(tarihGoster(bit))} · Toplam ${_adminKayitlar.length} ders, ${satirlar.length} öğretmen</div>
    <div style="overflow-x:auto;"><table><thead><tr><th>Öğretmen</th><th style="text-align:center;">Vekil Ders Sayısı</th></tr></thead><tbody>
    ${satirlar.map((s) => `<tr><td>${esc(s.ad)}</td><td style="text-align:center;font-weight:700;">${s.sayi}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function _listeCiz(el) {
  if (!_adminKayitlar.length) { el.innerHTML = '<div class="bos-mesaj">Kayıt yok.</div>'; return; }
  el.innerHTML = `<div style="overflow-x:auto;"><table><thead><tr>
    <th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Asıl Öğretmen</th><th>Vekil</th><th>Kaynak</th><th class="yazdirma-gizle"></th>
    </tr></thead><tbody>
    ${_adminKayitlar.map((k) => `<tr>
      <td style="white-space:nowrap;">${esc(tarihGoster(k.tarih))}</td>
      <td style="white-space:nowrap;">${k.ders_no}. ders</td>
      <td>${esc(k.sinif)} ${esc(k.ders_adi)}</td>
      <td>${esc(k.asil_ogretmen_ad || "-")}</td>
      <td><strong>${esc(k.vekil_ogretmen_ad)}</strong></td>
      <td style="font-size:12px;color:var(--text2);">${esc(KAYNAK_ETIKET[k.kaynak] || k.kaynak || "")}</td>
      <td class="yazdirma-gizle"><button class="btn btn-kirmizi btn-sm" data-id="${esc(k.id)}" onclick="vekilDersSil(this)">Sil</button></td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

function _onaysizCiz(el, onaysizlar) {
  if (!onaysizlar.length) { el.innerHTML = '<div class="bos-mesaj">Onay bekleyen atama yok.</div>'; return; }
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
      <button class="btn btn-yesil" id="vdTopluOnayBtn" onclick="vekilAtamalariTopluOnayla()">✓ Listedeki ${onaysizlar.length} atamanın tümünü onayla</button>
      <span id="vdTopluOnayDurum" style="font-size:13px;color:var(--text2);"></span>
    </div>
    <div style="overflow-x:auto;"><table><thead><tr>
    <th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Asıl Öğretmen</th><th>Atanan Vekil</th><th></th></tr></thead><tbody>
    ${onaysizlar.map((v, i) => `<tr>
      <td style="white-space:nowrap;">${esc(tarihGoster(v.date))}</td>
      <td style="white-space:nowrap;">${v.lesson_number}. ders</td>
      <td>${esc(v.class_id)} ${esc(v.lesson_name || "")}</td>
      <td>${esc(v.substitute_for_teacher_ad || ogretmenAd(v.teacher_id))}</td>
      <td>${esc(v.substitute_teacher_ad || ogretmenAd(v.substitute_teacher_id))}</td>
      <td><button class="btn btn-yesil btn-sm" data-i="${i}" onclick="vekilAtamaOnayla(this)">Onayla</button></td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

window.vekilAtamaOnayla = async (btn) => {
  const v = window._vdOnaysizlar?.[Number(btn.dataset.i)];
  if (!v) return;
  btn.disabled = true;
  try {
    await kayitOlustur(v, v.substitute_teacher_id, "sistem_onay");
    await window.vekilDerslerListele();
  } catch (err) {
    btn.disabled = false;
    mesajGoster("vdMesaj", err.message, "hata");
  }
};

// Listedeki (mevcut tarih/ogretmen filtresine uyan) tum onaysiz atamalari
// "derse girdi" olarak kaydeder. writeBatch yerine kayitOlustur: admin'in
// update izni oldugu icin batch, liste yuklendikten sonra baskasinin girdigi
// bir kaydin ustune yazabilirdi; kayitOlustur once var mi diye bakar.
window.vekilAtamalariTopluOnayla = async () => {
  const liste = [...(window._vdOnaysizlar || [])];
  if (!liste.length) return;
  if (!await sor(
    "Toplu Onay",
    `${liste.length} atama, atanan vekil öğretmen derse girmiş sayılarak ücret listesine eklenecek. Derse girilmediğini bildiğiniz atamalar varsa toplu onay yerine diğerlerini tek tek onaylayın.`,
    "Tümünü onayla", "btn-yesil",
  )) return;

  const btn = document.getElementById("vdTopluOnayBtn");
  const durum = document.getElementById("vdTopluOnayDurum");
  btn.disabled = true;
  let tamam = 0;
  const atlanan = [];
  for (let i = 0; i < liste.length; i += 10) {
    await Promise.all(liste.slice(i, i + 10).map(async (v) => {
      try {
        await kayitOlustur(v, v.substitute_teacher_id, "sistem_onay");
        tamam++;
      } catch (err) {
        atlanan.push(`${tarihGoster(v.date)} ${v.lesson_number}. ders ${v.class_id}: ${err.message}`);
      }
    }));
    durum.textContent = `${tamam + atlanan.length} / ${liste.length} işlendi...`;
  }

  await window.vekilDerslerListele();
  mesajGoster("vdMesaj",
    `${tamam} atama onaylandı.` + (atlanan.length ? ` ${atlanan.length} atama atlandı (ayrıntı konsolda).` : ""),
    atlanan.length ? "hata" : "basari");
  if (atlanan.length) console.warn("Toplu onayda atlananlar:\n" + atlanan.join("\n"));
};

window.vekilDersSil = async (btn) => {
  if (!await sor("Kaydı Sil", "Bu vekil ders kaydı silinecek. Ücret listesinden çıkar.", "Sil", "btn-kirmizi")) return;
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "vekil_dersler", btn.dataset.id));
    await window.vekilDerslerListele();
  } catch (err) {
    btn.disabled = false;
    mesajGoster("vdMesaj", "Hata: " + err.message, "hata");
  }
};

window.vekilDersYazdir = () => window.print();

// ── Geçmiş (veya herhangi bir) tarihe kayıt ekleme ──
// O tarih icin today_lessons varsa onu kullanir; yoksa (ör. o gun ders
// olusturulmamis) haftalik programdan (schedule) gun adina gore uretir.
window.vdEkleDersleriYukle = async () => {
  const tarih = document.getElementById("vdEkleTarih").value;
  const saat = Number(document.getElementById("vdEkleSaat").value);
  const sel = document.getElementById("vdEkleDers");
  _adminEkleDersler = [];
  if (!tarih || !saat) { sel.innerHTML = '<option value="">Önce tarih ve saat seçin</option>'; return; }
  sel.innerHTML = '<option value="">Yukleniyor...</option>';
  try {
    const gunSnap = await getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih)));
    if (!gunSnap.empty) {
      gunSnap.forEach((d) => {
        const v = d.data();
        if (v.lesson_number === saat) _adminEkleDersler.push({ id: d.id, ...v });
      });
    } else {
      const gunAdi = gunAdiGetir(tarih);
      const progSnap = await getDocs(query(collection(db, "schedule"), where("lesson_number", "==", saat)));
      progSnap.forEach((d) => {
        const v = d.data();
        if (normalizeGun(v.day) !== gunAdi) return;
        _adminEkleDersler.push({
          id: null, date: tarih, lesson_number: saat,
          class_id: v.class_id, lesson_name: v.lesson_name, teacher_id: v.teacher_id,
        });
      });
    }
    _adminEkleDersler.sort((a, b) => String(a.class_id).localeCompare(String(b.class_id), "tr"));
    sel.innerHTML = _adminEkleDersler.length
      ? '<option value="">Seçin</option>' + _adminEkleDersler.map((d, i) =>
          `<option value="${i}">${esc(d.class_id)} — ${esc(d.lesson_name || "")} — ${esc(ogretmenAd(d.teacher_id))}</option>`).join("")
      : '<option value="">Bu tarih/saatte ders bulunamadı</option>';
  } catch (err) {
    sel.innerHTML = '<option value="">Yüklenemedi</option>';
    mesajGoster("vdEkleMesaj", "Hata: " + err.message, "hata");
  }
};

window.vdEkleKaydet = async () => {
  const iStr = document.getElementById("vdEkleDers").value;
  const ders = iStr === "" ? null : _adminEkleDersler[Number(iStr)];
  const vekilId = document.getElementById("vdEkleVekil").value;
  if (!ders || !vekilId) { mesajGoster("vdEkleMesaj", "Tarih, saat, ders ve vekil öğretmeni seçin.", "hata"); return; }
  if (vekilId === ders.teacher_id) { mesajGoster("vdEkleMesaj", "Vekil öğretmen dersin kendi öğretmeni olamaz.", "hata"); return; }
  try {
    await kayitOlustur(ders, vekilId, "admin");
    mesajGoster("vdEkleMesaj", "Kayıt eklendi.", "basari");
    document.getElementById("vdEkleDers").value = "";
    await window.vekilDerslerListele();
  } catch (err) {
    mesajGoster("vdEkleMesaj", err.message, "hata");
  }
};
