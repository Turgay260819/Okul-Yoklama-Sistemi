import {
  db, auth, bugun, bugunHesapla,
  getDocs, getDoc, setDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor } from "./portal-utils.js";
import { xlsxYukle, sayfaOlustur, isoTarih, dosyaAdi, TARIH_SAAT_BICIMI } from "./portal-excel.js";

// ── VEKİL DERS KAYITLARI (ücret) ──
// vekil_dersler: "kim hangi derse girdi" sorusunun tek kaydi. SADECE ogretmen
// kendi sayfasindan acar (atama onayi ya da elle giris); idare kayit acamaz,
// hatali kaydi silebilir. Belge kimligi tarih_sinif_saat oldugu icin bir
// sinif-saate tek kayit acilir (ilk giren alir). Ogretmen bugune ve gecmis her
// gune yazar, kendi kaydini silebilir; gelecek kapali (firestore.rules
// ogretmenTarihi ile ayni sinir).

const KAYNAK_ETIKET = { sistem_onay: "Atama onayı", ogretmen: "Elle girdi", admin: "İdare girdi" };

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

const GUN_ADLARI = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

// Bir onceki is gunu: Pzt -> Cuma, Paz -> Cuma, Cmt -> Cuma, digerleri -> dun.
// firestore.rules oncekiIsGunuTR() ile ayni mantik; degisirse ikisi birlikte.
export function oncekiIsGunu(tarih) {
  const d = new Date(tarih + "T12:00:00");
  const gun = d.getDay();
  d.setDate(d.getDate() - (gun === 1 ? 3 : gun === 0 ? 2 : 1));
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

// Ogretmen bu tarihe kayit girebilir / kendi kaydini silebilir mi? Bugun ve
// gecmis her gun; gelecek degil. firestore.rules ogretmenTarihi ile ayni.
export function ogretmenTarihiMi(tarih) {
  return typeof tarih === "string" && tarih.length === 10 && tarih <= bugunHesapla();
}

function gunEtiketi(tarih) {
  const [, m, g] = tarih.split("-");
  return `${g}.${m} ${GUN_ADLARI[new Date(tarih + "T12:00:00").getDay()]}`;
}

// Oturumdaki ogretmen adina kayit acar. Once mukerrer kontrolu:
//  1) ayni sinif-saat icin kayit varsa (kendisi ya da baskasi girmis)
//  2) ogretmenin ayni gun ayni saatte baska bir sinif icin kaydi varsa
// Yaris durumunda kural reddeder (update izni yok); o da ayni mesaja cevrilir.
export async function kayitOlustur(ders, kaynak) {
  const ben = state.ogretmenDoc;
  if (!ben) throw new Error("Öğretmen kaydınız bulunamadı.");
  const id = kayitId(ders.date, ders.class_id, ders.lesson_number);
  const ref = doc(db, "vekil_dersler", id);

  const mevcutMesaji = (k) => k.vekil_ogretmen_id === ben.id
    ? "Mükerrer kayıt: Bu dersi zaten kaydettiniz."
    : `Bu ders zaten ${k.vekil_ogretmen_ad || "başka bir öğretmen"} tarafından girilmiş.`;

  const mevcut = await getDoc(ref);
  if (mevcut.exists()) throw new Error(mevcutMesaji(mevcut.data()));

  const benimSnap = await getDocs(query(collection(db, "vekil_dersler"), where("vekil_ogretmen_id", "==", ben.id)));
  const ayniSaat = benimSnap.docs.map((d) => d.data())
    .find((k) => k.tarih === ders.date && Number(k.ders_no) === Number(ders.lesson_number));
  if (ayniSaat) {
    throw new Error(`Mükerrer kayıt: ${tarihGoster(ders.date)} ${ders.lesson_number}. ders için zaten ${ayniSaat.sinif} ${ayniSaat.ders_adi || ""} kaydınız var. Aynı saatte iki derse girilemez; yanlışsa önce o kaydı silin.`);
  }

  try {
    await setDoc(ref, {
      tarih: ders.date,
      ders_no: ders.lesson_number,
      sinif: ders.class_id,
      ders_adi: ders.lesson_name || "",
      asil_ogretmen_id: ders.teacher_id || "",
      asil_ogretmen_ad: ders.teacher_id ? ogretmenAd(ders.teacher_id) : "",
      vekil_ogretmen_id: ben.id,
      vekil_ogretmen_ad: ben.ad || ogretmenAd(ben.id),
      kaynak,
      today_lesson_id: ders.id || null,
      olusturan_uid: auth.currentUser?.uid || null,
      olusturma: serverTimestamp(),
    });
  } catch (err) {
    const tekrar = await getDoc(ref).catch(() => null);
    if (tekrar?.exists()) throw new Error(mevcutMesaji(tekrar.data()));
    throw err;
  }
}

// Ogretmenin kendi kaydini silmesi (onay ile).
export async function kaydimiSil(id) {
  if (!await sor("Kaydı Sil", "Bu vekil ders kaydınız silinecek ve ücret listesinden çıkacak. Derse girmediyseniz ya da yanlış girdiyseniz silin.", "Sil", "btn-kirmizi")) return false;
  await deleteDoc(doc(db, "vekil_dersler", id));
  return true;
}

// ── Onay geçmişi (vekil_ders_gecmis, sunucu yazar) ──
const ISLEM_ETIKET = { onay: "✅ Atamayı onayladı", elle: "✏️ Elle girdi", silindi: "🗑 Kayıt silindi" };

function gecmisZaman(z) {
  return z?.toDate ? z.toDate().toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
}

function gecmisYapan(g, benimGorunum) {
  if (g.islem !== "silindi") return "";
  if (g.yapan === "sistem") return " (sistem)";
  if (g.yapan === "idare") return ` (idare: ${g.yapan_ad || "?"})`;
  return benimGorunum ? " (sizin tarafınızdan)" : " (öğretmenin kendisi)";
}

function gecmisTabloHtml(liste, benimGorunum) {
  if (!liste.length) return '<div class="bos-mesaj">Henüz geçmiş kaydı yok.</div>';
  return `<div style="overflow-x:auto;"><table><thead><tr>
    <th>Ne zaman</th>${benimGorunum ? "" : "<th>Öğretmen</th>"}<th>İşlem</th><th>Ders</th></tr></thead><tbody>
    ${liste.map((g) => `<tr${g.islem === "silindi" ? ' style="color:var(--text2);"' : ""}>
      <td style="white-space:nowrap;font-size:12px;">${esc(gecmisZaman(g.zaman))}</td>
      ${benimGorunum ? "" : `<td>${esc(g.vekil_ogretmen_ad)}</td>`}
      <td style="white-space:nowrap;">${esc((ISLEM_ETIKET[g.islem] || g.islem) + gecmisYapan(g, benimGorunum))}</td>
      <td>${esc(tarihGoster(g.tarih))} · ${esc(g.ders_no)}. ders · ${esc(g.sinif)} ${esc(g.ders_adi)}${g.asil_ogretmen_ad ? ` <span style="color:var(--text2);font-size:12px;">(${esc(g.asil_ogretmen_ad)} yerine)</span>` : ""}</td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

// ═══════════════ ÖĞRETMEN: VEKİL DERSLERİM ═══════════════

let _seciliTarih = null;   // null = bugun
let _bugunDersler = [];    // secili gunun dersleri
let _bugunKayitlar = {};   // secili gunun vekil_dersler kayitlari

window.vekilGunSec = (secim) => {
  _seciliTarih = secim === "onceki" ? oncekiIsGunu(bugunHesapla()) : null;
  vekilDerslerimYukle();
};

window.vekilTarihSecildi = (t) => {
  if (!ogretmenTarihiMi(t)) return;
  _seciliTarih = t === bugunHesapla() ? null : t;
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
  if (_seciliTarih && !ogretmenTarihiMi(_seciliTarih)) _seciliTarih = null;
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
    // Bu ay + (ay basindaysa) onceki is gunu + secili gunun ayi; eski bir aya
    // girilen kayit da listede gorunsun.
    const listeBas = [ayBasi(bugunTarih), onceki, ayBasi(tarih)].sort()[0];
    kok.innerHTML =
      _gunSeciciHtml(bugunTarih, onceki, tarih) +
      _atananlarHtml(ben, tarih, bugunMu) +
      _elleEkleHtml(tarih, bugunMu) +
      _kayitlarimHtml(benimKayitlar.filter((k) => k.tarih >= listeBas && k.tarih <= bugunTarih)) +
      `<div class="kart"><div class="kart-baslik">Onay Geçmişim</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Yaptığınız her onay, elle giriş ve silme burada tarih-saatiyle tutulur (son 50 işlem).</p>
        <div id="vekilGecmisim"><div class="yukleniyor">Yukleniyor...</div></div></div>`;
    _saatSecenekleriniDoldur();
    _gecmisimYukle();
  } catch (err) {
    kok.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
}
window.vekilDerslerimYukle = vekilDerslerimYukle;

async function _gecmisimYukle() {
  const el = document.getElementById("vekilGecmisim");
  if (!el || !auth.currentUser) return;
  try {
    const snap = await getDocs(query(collection(db, "vekil_ders_gecmis"), where("vekil_uid", "==", auth.currentUser.uid)));
    const liste = snap.docs.map((d) => d.data())
      .sort((a, b) => (b.zaman?.toMillis?.() || 0) - (a.zaman?.toMillis?.() || 0)).slice(0, 50);
    el.innerHTML = gecmisTabloHtml(liste, true);
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Geçmiş yüklenemedi: ${esc(err.message)}</div>`;
  }
}

function _gunSeciciHtml(bugunTarih, onceki, tarih) {
  return `<div class="sekme-bar" style="margin-bottom:12px;align-items:center;flex-wrap:wrap;gap:6px;">
    <button class="sekme-btn${tarih === bugunTarih ? " aktif" : ""}" onclick="vekilGunSec('bugun')">Bugün (${esc(gunEtiketi(bugunTarih))})</button>
    <button class="sekme-btn${tarih === onceki ? " aktif" : ""}" onclick="vekilGunSec('onceki')">Önceki iş günü (${esc(gunEtiketi(onceki))})</button>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;">Başka gün:
      <input type="date" id="vekilTarihSec" max="${esc(bugunTarih)}" value="${esc(tarih)}" onchange="vekilTarihSecildi(this.value)"></label>
  </div>`;
}

function _atananlarHtml(ben, tarih, bugunMu) {
  const atananlar = _bugunDersler
    .filter((d) => d.substitute_teacher_id === ben.id)
    .sort((a, b) => a.lesson_number - b.lesson_number);
  let html = `<div class="kart">
    <div class="kart-baslik">${bugunMu ? "Bugün" : esc(gunEtiketi(tarih))} Size Atanan Vekil Dersler</div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Ücret, sadece sizin "Derse girdim" ile onayladığınız veya aşağıdan eklediğiniz dersler için ödenir. Bugün ya da geçmiş herhangi bir gün için kayıt girebilir (üstten gün seçin), kendi kaydınızı silebilirsiniz.</p>`;
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
        <button class="btn btn-gri btn-sm" data-id="${esc(id)}" onclick="vekilKaydimiSil(this)">Geri al</button>`;
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
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Size sistemden atanmadığı halde ${bugunMu ? "bugün" : esc(gunEtiketi(tarih)) + " günü"} başka bir öğretmenin yerine derse girdiyseniz buradan ekleyin. Atanan bir dersi burada tekrar girmeyin; yukarıdan "Derse girdim" deyin.</p>
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

function _kayitlarimHtml(kayitlar) {
  kayitlar.sort((a, b) => b.tarih.localeCompare(a.tarih) || a.ders_no - b.ders_no);
  let html = `<div class="kart">
    <div class="kart-baslik">Girdiğim Vekil Ders Kayıtları <span class="rozet rozet-mavi">${kayitlar.length} ders</span></div>
    <p style="font-size:13px;color:var(--text2);margin-bottom:10px;">Bu ayki (ve seçili günün ayındaki) kayıtlarınız. Derse girmediğiniz ya da yanlış girdiğiniz bir kaydı silebilirsiniz.</p>`;
  if (!kayitlar.length) return html + '<div class="bos-mesaj">Bu ay kayıtlı vekil dersiniz yok.</div></div>';
  html += '<div style="overflow-x:auto;"><table><thead><tr><th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Yerine</th><th>Nasıl</th><th></th></tr></thead><tbody>';
  html += kayitlar.map((k) => `<tr>
    <td style="white-space:nowrap;">${esc(tarihGoster(k.tarih))}</td><td style="white-space:nowrap;">${k.ders_no}. ders</td>
    <td>${esc(k.sinif)} ${esc(k.ders_adi)}</td><td>${esc(k.asil_ogretmen_ad || "-")}</td>
    <td style="font-size:12px;color:var(--text2);">${esc(KAYNAK_ETIKET[k.kaynak] || "")}</td>
    <td>${ogretmenTarihiMi(k.tarih)
      ? `<button class="btn btn-kirmizi btn-sm" data-id="${esc(k.id)}" onclick="vekilKaydimiSil(this)">Sil</button>`
      : '<span style="font-size:11px;color:var(--text2);">Silme süresi doldu</span>'}</td></tr>`).join("");
  return html + '</tbody></table></div><div class="mesaj" id="vekilKayitlarimMesaj" style="margin-top:8px;"></div></div>';
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
    await kayitOlustur(ders, "ogretmen");
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
    await kayitOlustur(ders, "sistem_onay");
    await vekilDerslerimYukle();
  } catch (err) {
    btn.disabled = false;
    mesajGoster("vekilAtananMesaj", err.message, "hata");
  }
};

window.vekilKaydimiSil = async (btn) => {
  btn.disabled = true;
  try {
    if (await kaydimiSil(btn.dataset.id)) await vekilDerslerimYukle();
    else btn.disabled = false;
  } catch (err) {
    btn.disabled = false;
    const yer = document.getElementById("vekilKayitlarimMesaj") ? "vekilKayitlarimMesaj" : "vekilAtananMesaj";
    mesajGoster(yer, "Silinemedi: " + err.message, "hata");
  }
};

// ═══════════════ ADMİN: VEKİL DERS KAYITLARI ═══════════════
// Sadece goruntuleme ve hatali kaydi silme. Kayit acma yok.

let _adminKayitlar = [];
let _adminOnaysizlar = [];
let _adminGecmis = [];
let _adminFiltre = { bas: "", bit: "", ogretmen: "" }; // Excel ciktisi ekrandakiyle ayni olsun

export function vekilDerslerAdminYukle() {
  const bas = document.getElementById("vdBaslangic");
  const bit = document.getElementById("vdBitis");
  if (bas && !bas.value) bas.value = ayBasi(bugun);
  if (bit && !bit.value) bit.value = bugun;

  const ogrOptions = [...state.ogretmenler]
    .sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"))
    .map((o) => `<option value="${esc(o.id)}">${esc(o.ad)}</option>`).join("");
  const filtre = document.getElementById("vdOgretmen");
  if (filtre && filtre.options.length <= 1) filtre.innerHTML = '<option value="">Tüm öğretmenler</option>' + ogrOptions;

  window.vekilDerslerListele();
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
      const v = d.data();
      if (!v.substitute_teacher_id) return;
      if (ogrFiltre && v.substitute_teacher_id !== ogrFiltre) return;
      if (kayitIdleri.has(kayitId(v.date, v.class_id, v.lesson_number))) return;
      onaysizlar.push(v);
    });
    onaysizlar.sort((a, b) => a.date.localeCompare(b.date) || a.lesson_number - b.lesson_number);
    _adminOnaysizlar = onaysizlar;
    _adminFiltre = { bas, bit, ogretmen: ogrFiltre };

    _ozetCiz(ozetEl, bas, bit);
    _listeCiz(listeEl);
    _onaysizCiz(onaysizEl, onaysizlar);
    _adminGecmisYukle(bas, bit, ogrFiltre);
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
    <th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Asıl Öğretmen</th><th>Vekil</th><th>Nasıl</th><th class="yazdirma-gizle"></th>
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
  if (!onaysizlar.length) { el.innerHTML = '<div class="bos-mesaj">Onaylanmamış atama yok.</div>'; return; }
  el.innerHTML = `<div style="overflow-x:auto;"><table><thead><tr>
    <th>Tarih</th><th>Saat</th><th>Sınıf / Ders</th><th>Asıl Öğretmen</th><th>Atanan Vekil</th></tr></thead><tbody>
    ${onaysizlar.map((v) => `<tr>
      <td style="white-space:nowrap;">${esc(tarihGoster(v.date))}</td>
      <td style="white-space:nowrap;">${v.lesson_number}. ders</td>
      <td>${esc(v.class_id)} ${esc(v.lesson_name || "")}</td>
      <td>${esc(v.substitute_for_teacher_ad || ogretmenAd(v.teacher_id))}</td>
      <td>${esc(v.substitute_teacher_ad || ogretmenAd(v.substitute_teacher_id))}</td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

// Ders tarihi secili aralikta olan tum onay/giris/silme islemleri.
async function _adminGecmisYukle(bas, bit, ogrFiltre) {
  const el = document.getElementById("vdGecmis");
  if (!el) return;
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const snap = await getDocs(query(collection(db, "vekil_ders_gecmis"), where("tarih", ">=", bas), where("tarih", "<=", bit)));
    const liste = snap.docs.map((d) => d.data())
      .filter((g) => !ogrFiltre || g.vekil_ogretmen_id === ogrFiltre)
      .sort((a, b) => (b.zaman?.toMillis?.() || 0) - (a.zaman?.toMillis?.() || 0));
    _adminGecmis = liste;
    el.innerHTML = gecmisTabloHtml(liste, false);
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Geçmiş yüklenemedi: ${esc(err.message)}</div>`;
  }
}

window.vekilDersSil = async (btn) => {
  if (!await sor("Kaydı Sil", "Bu vekil ders kaydı silinecek ve ücret listesinden çıkacak. İdare kayıt ekleyemediği için silinen kaydı ancak öğretmen kendi sayfasından yeniden girebilir.", "Sil", "btn-kirmizi")) return;
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

// ── Excel çıktısı (admin) ──
// Ekranda listelenen veri (tarih araligi + ogretmen filtresi) dort sayfa halinde:
// Ogretmen Toplamlari (ucret listesi), Kayitlar, Onaylanmamis Atamalar, Onay Gecmisi.
window.vekilDersExcel = async () => {
  const btn = document.getElementById("vdExcelBtn");
  const { bas, bit, ogretmen } = _adminFiltre;
  if (!bas) { mesajGoster("vdMesaj", "Önce Listele'ye basın.", "hata"); return; }
  const eski = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Hazırlanıyor...";
  try {
    const XLSX = await xlsxYukle();
    const zaman = (z) => (z?.toDate ? z.toDate() : "");

    const sayac = {};
    _adminKayitlar.forEach((k) => {
      (sayac[k.vekil_ogretmen_id] ||= { ad: k.vekil_ogretmen_ad, sayi: 0 }).sayi++;
    });
    const toplamlar = Object.values(sayac).sort((a, b) => a.ad.localeCompare(b.ad, "tr"));
    const s1 = [["Öğretmen", "Vekil Ders Sayısı"], ...toplamlar.map((t) => [t.ad, t.sayi]),
      [], ["Toplam", _adminKayitlar.length],
      [], [`Dönem: ${tarihGoster(bas)} – ${tarihGoster(bit)}${ogretmen ? " · " + ogretmenAd(ogretmen) : ""}`]];

    const s2 = [["Tarih", "Saat", "Sınıf", "Ders", "Asıl Öğretmen", "Vekil Öğretmen", "Nasıl", "Kayıt Zamanı"],
      ..._adminKayitlar.map((k) => [isoTarih(k.tarih), k.ders_no, k.sinif, k.ders_adi, k.asil_ogretmen_ad || "",
        k.vekil_ogretmen_ad, KAYNAK_ETIKET[k.kaynak] || k.kaynak || "", zaman(k.olusturma)])];

    const s3 = [["Tarih", "Saat", "Sınıf", "Ders", "Asıl Öğretmen", "Atanan Vekil"],
      ..._adminOnaysizlar.map((v) => [isoTarih(v.date), v.lesson_number, v.class_id, v.lesson_name || "",
        v.substitute_for_teacher_ad || ogretmenAd(v.teacher_id), v.substitute_teacher_ad || ogretmenAd(v.substitute_teacher_id)])];

    const s4 = [["Ne Zaman", "Öğretmen", "İşlem", "Yapan", "Ders Tarihi", "Saat", "Sınıf", "Ders", "Asıl Öğretmen"],
      ..._adminGecmis.map((g) => [zaman(g.zaman), g.vekil_ogretmen_ad, (ISLEM_ETIKET[g.islem] || g.islem).replace(/^\S+\s/, ""),
        g.yapan === "idare" ? "İdare: " + (g.yapan_ad || "?") : g.yapan === "sistem" ? "Sistem" : "Öğretmen",
        isoTarih(g.tarih), g.ders_no, g.sinif, g.ders_adi, g.asil_ogretmen_ad || ""])];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s1, [32, 18]), "Öğretmen Toplamları");
    const ws2 = sayfaOlustur(XLSX, s2, [12, 6, 8, 20, 24, 24, 14, 18], [], [0]);
    XLSX.utils.book_append_sheet(wb, ws2, "Kayıtlar");
    XLSX.utils.book_append_sheet(wb, sayfaOlustur(XLSX, s3, [12, 6, 8, 20, 24, 24], [], [0]), "Onaylanmamış Atamalar");
    const ws4 = sayfaOlustur(XLSX, s4, [18, 24, 20, 20, 12, 6, 8, 20, 24], [], [4]);
    XLSX.utils.book_append_sheet(wb, ws4, "Onay Geçmişi");
    // Kayit zamani / islem zamani: tarih + saat bicimi
    [[ws2, 7], [ws4, 0]].forEach(([ws, c]) => {
      const r = XLSX.utils.decode_range(ws["!ref"]);
      for (let i = 1; i <= r.e.r; i++) {
        const h = ws[XLSX.utils.encode_cell({ r: i, c })];
        if (h && h.t === "d") h.z = TARIH_SAAT_BICIMI;
      }
    });

    XLSX.writeFile(wb, dosyaAdi(`Vekil Ders Kayitlari ${tarihGoster(bas)}-${tarihGoster(bit)}${ogretmen ? " " + ogretmenAd(ogretmen) : ""}`) + ".xlsx");
  } catch (err) {
    mesajGoster("vdMesaj", err.message, "hata");
  }
  btn.disabled = false;
  btn.textContent = eski;
};

// ── Günlük görevlendirme yazısı (admin) ──
// Secili gunde ogretmenin kendi onayi (sistem_onay) ya da elle girisi
// (ogretmen) ile olusmus vekil_dersler kayitlari; resmi yazi + Excel.
// Okul/mudur bilgileri nobet2.html gorevlendirme yazisiyla ortak
// (nobet2_ayarlar/yazi); varsayilanlar oradaki YAZI_VARSAYILAN ile ayni.
const VY_VARSAYILAN = {
  ilce: "KEŞAN KAYMAKAMLIĞI",
  okul: "AHMET YENİCE ORTAOKULU MÜDÜRLÜĞÜ",
  mudur_ad: "Süleyman AYYILDIZ",
  mudur_unvan: "Okul Müdürü",
};
const VY_KAYNAK = { sistem_onay: "Atama onayı", ogretmen: "Elle giriş" };
let _vyAyar = { ...VY_VARSAYILAN };
let _vyKayitlar = [];
let _vyTarih = "";

function _vyMetin(tarih) {
  return `Okulumuzda ${tarihGoster(tarih)} ${GUN_ADLARI[new Date(tarih + "T12:00:00").getDay()]} günü, derse giremeyen öğretmenlerin yerine aşağıda belirtilen öğretmenler belirtilen ders saatlerinde Okul Müdürlüğünce vekil öğretmen olarak görevlendirilmiştir.`;
}

function _vyToplamlar() {
  const sayac = {};
  _vyKayitlar.forEach((k) => {
    (sayac[k.vekil_ogretmen_id] ||= { ad: k.vekil_ogretmen_ad, sayi: 0 }).sayi++;
  });
  return Object.values(sayac).sort((a, b) => a.ad.localeCompare(b.ad, "tr"));
}

// Kayitlar ogretmene gore sirali; ardisik ayni ogretmen bir grup. Her grup
// tabloda tek Sira / Ogretmen / Imza hucresi (rowspan, Excel'de merge) alir.
function _vyGruplar() {
  const gruplar = [];
  _vyKayitlar.forEach((k) => {
    const son = gruplar[gruplar.length - 1];
    if (son && son.id === k.vekil_ogretmen_id) son.dersler.push(k);
    else gruplar.push({ id: k.vekil_ogretmen_id, ad: k.vekil_ogretmen_ad, dersler: [k] });
  });
  return gruplar;
}

function _vyButonlar(acik) {
  document.getElementById("vyExcelBtn").disabled = !acik;
  document.getElementById("vyYazdirBtn").disabled = !acik;
}

window.vekilYaziAc = async () => {
  try {
    const ayarDoc = await getDoc(doc(db, "nobet2_ayarlar", "yazi"));
    const a = ayarDoc.exists() ? ayarDoc.data() : {};
    _vyAyar = { ...VY_VARSAYILAN };
    Object.keys(VY_VARSAYILAN).forEach((k) => { if (a[k]) _vyAyar[k] = a[k]; });
  } catch (e) {
    _vyAyar = { ...VY_VARSAYILAN };
  }
  const tarihEl = document.getElementById("vyTarih");
  if (!tarihEl.value) tarihEl.value = bugunHesapla();
  document.getElementById("vekilYaziModal").classList.add("aktif");
  await window.vekilYaziYukle();
};

window.vekilYaziKapat = () => document.getElementById("vekilYaziModal").classList.remove("aktif");

window.vekilYaziYukle = async () => {
  const tarih = document.getElementById("vyTarih").value;
  const onizleme = document.getElementById("vyOnizleme");
  const uyari = document.getElementById("vyUyari");
  uyari.hidden = true;
  _vyKayitlar = [];
  _vyTarih = tarih;
  _vyButonlar(false);
  if (!tarih) { onizleme.innerHTML = '<div class="bos-mesaj">Tarih seçin.</div>'; return; }
  onizleme.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const [kayitSnap, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "vekil_dersler"), where("tarih", "==", tarih))),
      getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih))),
    ]);
    if (document.getElementById("vyTarih").value !== tarih) return; // bu arada tarih degisti
    const kayitIdleri = new Set();
    const liste = [];
    kayitSnap.forEach((d) => {
      kayitIdleri.add(d.id);
      const k = d.data();
      if (VY_KAYNAK[k.kaynak]) liste.push(k);
    });
    liste.sort((a, b) => (a.vekil_ogretmen_ad || "").localeCompare(b.vekil_ogretmen_ad || "", "tr") || a.ders_no - b.ders_no);
    _vyKayitlar = liste;

    let onaysiz = 0;
    dersSnap.forEach((d) => {
      const v = d.data();
      if (v.substitute_teacher_id && !kayitIdleri.has(kayitId(v.date, v.class_id, v.lesson_number))) onaysiz++;
    });
    if (onaysiz) {
      uyari.textContent = `Bu gün ${onaysiz} vekil atama henüz öğretmen tarafından onaylanmamış; bunlar yazıya girmez. Öğretmen onaylarsa yazıyı yeniden alın.`;
      uyari.hidden = false;
    }
    window.vekilYaziOnizle();
  } catch (err) {
    onizleme.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
};

function _vyHtml() {
  const a = _vyAyar;
  const satirlar = _vyGruplar().map((g, gi) => g.dersler.map((k, i) => {
    const rs = g.dersler.length > 1 ? ` rowspan="${g.dersler.length}"` : "";
    return `<tr>
      ${i === 0 ? `<td${rs}>${gi + 1}</td><td class="yazi-sol"${rs}>${esc(g.ad)}</td>` : ""}
      <td>${esc(k.ders_no)}. ders</td><td>${esc(k.sinif)}</td><td class="yazi-sol">${esc(k.ders_adi)}</td>
      <td class="yazi-sol">${esc(k.asil_ogretmen_ad || "-")}</td><td>${esc(VY_KAYNAK[k.kaynak])}</td>
      ${i === 0 ? `<td class="yazi-imza-hucre"${rs}></td>` : ""}</tr>`;
  }).join("")).join("");
  const toplamlar = _vyToplamlar().map((t) => `${esc(t.ad)} – ${t.sayi} ders`).join("; ");
  return `<div class="yazi-kagit">
    <div class="yazi-ust">T.C.<br>${esc(a.ilce || VY_VARSAYILAN.ilce)}<br>${esc(a.okul)}</div>
    <div class="yazi-satir"><span></span><span>${esc(tarihGoster(_vyTarih))}</span></div>
    <div class="yazi-satir"><span>Konu : Vekil Ders Görevlendirmesi</span></div>
    <div class="yazi-hitap">İLGİLİ ÖĞRETMENLERE</div>
    <p class="yazi-metin">${esc(_vyMetin(_vyTarih))}</p>
    <table class="yazi-tablo"><thead><tr>
      <th>Sıra</th><th>Öğretmen</th><th>Ders Saati</th><th>Sınıf</th><th>Ders</th><th>Yerine Girdiği Öğretmen</th><th>Kayıt Şekli</th><th>İmza</th>
    </tr></thead><tbody>${satirlar}</tbody></table>
    <div class="yazi-toplam"><b>Toplam ${_vyKayitlar.length} ders:</b> ${toplamlar}</div>
    <div class="yazi-imza">
      <div>Görevlendiren</div>
      <div class="yazi-imza-bosluk"></div>
      <div>${esc(a.mudur_ad)}</div>
      <div>${esc(a.mudur_unvan)}</div>
    </div>
  </div>`;
}

window.vekilYaziOnizle = () => {
  const onizleme = document.getElementById("vyOnizleme");
  if (!_vyTarih) return;
  if (!_vyKayitlar.length) {
    onizleme.innerHTML = '<div class="bos-mesaj">Bu gün için öğretmen onaylı vekil ders kaydı yok.</div>';
    _vyButonlar(false);
    return;
  }
  onizleme.innerHTML = _vyHtml();
  _vyButonlar(true);
};

window.vekilYaziYazdir = () => {
  if (!_vyKayitlar.length) return;
  document.getElementById("vyYazdirAlan").innerHTML = _vyHtml();
  document.body.classList.add("yazi-yazdir");
  const bitir = () => { document.body.classList.remove("yazi-yazdir"); window.removeEventListener("afterprint", bitir); };
  window.addEventListener("afterprint", bitir);
  window.print();
};

// Tek sayfa, yazi duzeninde: baslik, metin, tablo, ogretmen toplamlari, imza.
window.vekilYaziExcel = async () => {
  if (!_vyKayitlar.length) return;
  const btn = document.getElementById("vyExcelBtn");
  btn.disabled = true;
  try {
    const XLSX = await xlsxYukle();
    const a = _vyAyar;
    // SheetJS (ucretsiz surum) hucrede satir kaydirma yapamiyor; metin elle bolunur.
    const metinSatirlari = [];
    _vyMetin(_vyTarih).split(" ").forEach((kelime) => {
      const son = metinSatirlari.length - 1;
      if (son >= 0 && (metinSatirlari[son] + " " + kelime).length <= 95) metinSatirlari[son] += " " + kelime;
      else metinSatirlari.push(kelime);
    });
    const metinBas = 9;
    const s = [
      ["T.C."], [a.ilce || VY_VARSAYILAN.ilce], [a.okul], [],
      ["", "", "", "", "", "", "", tarihGoster(_vyTarih)],
      ["Konu : Vekil Ders Görevlendirmesi"], [],
      ["İLGİLİ ÖĞRETMENLERE"], [],
      ...metinSatirlari.map((m) => [m]), [],
      ["Sıra", "Öğretmen", "Ders Saati", "Sınıf", "Ders", "Yerine Girdiği Öğretmen", "Kayıt Şekli", "İmza"],
    ];
    // Ogretmen basina tek Sira / Ogretmen / Imza hucresi (satirlar boyunca birlesik).
    const grupMerge = [];
    const tabloSatirlari = [];
    _vyGruplar().forEach((g, gi) => {
      const bas = s.length;
      g.dersler.forEach((k, i) => {
        tabloSatirlari.push(s.length);
        s.push([i === 0 ? gi + 1 : "", i === 0 ? g.ad : "", `${k.ders_no}. ders`, k.sinif, k.ders_adi || "",
          k.asil_ogretmen_ad || "", VY_KAYNAK[k.kaynak], ""]);
      });
      if (g.dersler.length > 1) {
        const bit = bas + g.dersler.length - 1;
        [0, 1, 7].forEach((c) => grupMerge.push({ s: { r: bas, c }, e: { r: bit, c } }));
      }
    });
    s.push(
      [],
      ["", "Öğretmen", "Vekil Ders Sayısı"],
      ..._vyToplamlar().map((t) => ["", t.ad, t.sayi]),
      ["", "Toplam", _vyKayitlar.length],
      [], [],
    );
    const imzaBas = s.length;
    s.push(["", "", "", "", "", "Görevlendiren"], [], [], ["", "", "", "", "", a.mudur_ad], ["", "", "", "", "", a.mudur_unvan]);

    const ws = XLSX.utils.aoa_to_sheet(s);
    ws["!cols"] = [6, 26, 10, 8, 20, 26, 14, 18].map((w) => ({ wch: w }));
    ws["!rows"] = [];
    tabloSatirlari.forEach((r) => (ws["!rows"][r] = { hpt: 24 })); // imza atilacak yukseklik
    const tam = (r) => ({ s: { r, c: 0 }, e: { r, c: 7 } });
    const imza = (r) => ({ s: { r, c: 5 }, e: { r, c: 7 } });
    ws["!merges"] = [tam(0), tam(1), tam(2), tam(5), tam(7),
      ...metinSatirlari.map((m, i) => tam(metinBas + i)),
      ...grupMerge,
      imza(imzaBas), imza(imzaBas + 3), imza(imzaBas + 4)];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Görevlendirme");
    XLSX.writeFile(wb, dosyaAdi(`Vekil Ders Gorevlendirme ${tarihGoster(_vyTarih)}`) + ".xlsx");
  } catch (err) {
    mesajGoster("vyMesaj", err.message, "hata");
  }
  btn.disabled = false;
};
