import {
  db, auth, getDocs, setDoc, collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { esc, normalizeGun } from "./portal-utils.js";

// ── KELEBEK SINAV: admin (portal-kelebek.js) ve ogretmen
// (portal-kelebek-ogretmen.js) ekranlarinin ortak parcalari: salon sirasi,
// gozetmen hesabi ve salon yoklamasi.

const GUNLER = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];
export const DIGER = "__diger";

export const trTarih = (t) => { const [y, m, d] = String(t || "").split("-"); return d ? `${d}.${m}.${y}` : ""; };
export const saatMetni = (s) => (s || []).map((x) => x + ".").join(", ") + " ders";
const _saat = (z) => z?.toDate ? z.toDate().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "şimdi";

// Kayitli salonlar (sinav.salonlar) -> { ad, sinif, kapasite }
export function sinavSalonlari(sinav) {
  return (sinav.salonlar || []).map((s) => ({ ad: (s.ad || "").trim(), sinif: s.sinif && s.sinif !== DIGER ? s.sinif : null, kapasite: Number(s.kapasite) || 0 }))
    .filter((s) => s.ad);
}

// Salon listesindeki sira, sonra dagitimda olup listede olmayan salonlar.
export function salonSirasi(salonAdlari, dagilim) {
  const sira = [...salonAdlari];
  [...new Set(dagilim.map((d) => d.salon))].forEach((s) => { if (!sira.includes(s)) sira.push(s); });
  return sira;
}
export const siraliSalon = (dagilim, salon) => dagilim.filter((d) => d.salon === salon)
  .sort((a, b) => (a.sira ?? 0) - (b.sira ?? 0) || a.ad.localeCompare(b.ad, "tr"));

// ── Gözetmenler ──
// Otomatik: o tarih+saat+salon sinifinda dersi olan ogretmen (today_lessons;
// vekil varsa vekil), today_lessons yoksa haftalik program. Raporlu isaretlenir.
let _program = null;  // schedule (ilk ihtiyacta)

export async function programDersleri(tarih) {
  const [gunlukSnap, raporSnap] = await Promise.all([
    getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih))),
    getDocs(query(collection(db, "ogretmen_rapor"), where("baslangic_tarihi", "<=", tarih))),
  ]);
  let dersler = gunlukSnap.docs.map((d) => d.data());
  let kaynak = "günlük ders tablosu";
  if (!dersler.length) {
    if (!_program) _program = (await getDocs(collection(db, "schedule"))).docs.map((d) => d.data());
    const gun = GUNLER[new Date(tarih + "T12:00:00").getDay()];
    dersler = _program.filter((d) => normalizeGun(d.day) === gun);
    kaynak = "haftalık ders programı";
  }
  const raporlu = new Set();
  raporSnap.forEach((d) => { const r = d.data(); if (r.bitis_tarihi >= tarih) raporlu.add(r.ogretmen_id); });
  return { dersler, kaynak, raporlu };
}

// "salon|saat" -> programdaki ogretmen
export function otoGozetmen(salonlar, saatler, dersler, ogretmenAd) {
  const oto = {};
  salonlar.forEach((s) => saatler.forEach((saat) => {
    const ders = s.sinif ? dersler.find((d) => d.class_id === s.sinif && Number(d.lesson_number) === saat) : null;
    const id = ders ? (ders.substitute_teacher_id || ders.teacher_id || "") : "";
    oto[s.ad + "|" + saat] = { id, ad: ogretmenAd(id) };
  }));
  return oto;
}

// oto uzerine adminin elle degisiklikleri (sinav.gozetmenler) biner.
export function gozetmenTablosu(salonlar, saatler, oto, raporlu, elleler, ogretmenAd) {
  const tablo = {};
  salonlar.forEach((s) => saatler.forEach((saat) => {
    const anahtar = s.ad + "|" + saat;
    const otoId = oto[anahtar]?.id || "";
    const otoAd = oto[anahtar]?.ad || ogretmenAd(otoId);
    const elle = (elleler || {})[anahtar];
    tablo[anahtar] = elle
      ? { id: elle.ogretmen_id, ad: elle.ad, raporlu: raporlu.has(elle.ogretmen_id), kaynak: "elle", asil_id: otoId, asil_ad: otoAd }
      : { id: otoId, ad: otoAd, raporlu: !!otoId && raporlu.has(otoId), kaynak: "program" };
  }));
  return tablo;
}

// Tarihi gecmis sinav: sinav gunu kaydedilen gozetmen tablosu kullanilir;
// program/vekil/rapor sonradan degisse de gecmis bilgi degismez.
export function gecmisGozetmenKaydi(sinav, salonlar, bugun) {
  const kayit = sinav.gozetmen_kayit;
  const anahtarlar = salonlar.flatMap((s) => (sinav.saatler || []).map((saat) => s.ad + "|" + saat));
  return sinav.tarih < bugun && kayit?.tarih === sinav.tarih && kayit.oto && anahtarlar.every((k) => k in kayit.oto) ? kayit : null;
}

export async function gozetmenHesapla(sinav, salonlar, ogretmenAd, bugun) {
  const saatler = sinav.saatler || [];
  const kayit = gecmisGozetmenKaydi(sinav, salonlar, bugun);
  if (kayit) return { tablo: gozetmenTablosu(salonlar, saatler, kayit.oto, new Set(kayit.raporlu || []), sinav.gozetmenler, ogretmenAd), kaynak: kayit.kaynak || "program", kayittan: true };
  const { dersler, kaynak, raporlu } = await programDersleri(sinav.tarih);
  return { tablo: gozetmenTablosu(salonlar, saatler, otoGozetmen(salonlar, saatler, dersler, ogretmenAd), raporlu, sinav.gozetmenler, ogretmenAd), kaynak, kayittan: false };
}

// ── Salon yoklaması ──
// kelebek_sinavlar/{id}/yoklama/{saat}_{salon}: her ders saatinin gozetmeni
// kendi saatinin yoklamasini girer. Ayni salonda onceki saatte yoklama varsa
// form ondan dolu gelir; degisiklik yoksa "aynı" diye tek tusla onaylanir.
// Yok listesi ad/no/sube kopyasiyla saklanir (dagitim sonradan degisse de).
export const yoklamaId = (salon, saat) => `${saat}_${String(salon).replace(/\//g, "-")}`;

export async function yoklamaOku(sinavId) {
  const snap = await getDocs(collection(db, "kelebek_sinavlar", sinavId, "yoklama"));
  return new Map(snap.docs.map((d) => [d.id, d.data()]));
}

// Ayni salonda bu saatten onceki en son yoklama
export function oncekiYoklama(kayitlar, saatler, salon, saat) {
  return (saatler || []).filter((s) => s < saat).sort((a, b) => b - a)
    .map((s) => kayitlar.get(yoklamaId(salon, s))).find(Boolean) || null;
}

export const yokMetni = (k) => (k?.yoklar || []).map((x) => `${x.ad} (${x.sinif})`).join(", ");

export function yoklamaDurumHtml(k) {
  if (!k) return '<span style="color:#e65100;">⏳ Yoklama bekliyor</span>';
  const yok = (k.yoklar || []).length;
  return `<span style="color:#34a853;font-weight:600;">${k.tur === "ayni" ? `✓ ${k.onceki_saat}. dersle aynı` : "✓ Yoklama girildi"}</span>
    · ${yok ? `<strong style="color:#ea4335;">${yok} yok</strong>` : "<strong>tam</strong>"}
    <span style="font-size:11px;color:var(--text2);">(${esc(k.ogretmen_ad || "")} · ${esc(_saat(k.zaman))})</span>`;
}

// Yoklama formu: el icine cizilir. kim = { id, ad } (girisi yapan).
// Kaydedince onKaydet(kayit) cagrilir; iptalde onKapat().
export function yoklamaFormuCiz(el, { sinav, salon, saat, kayitlar, kim, onKaydet, onKapat }) {
  const liste = siraliSalon(sinav.dagilim || [], salon);
  const mevcut = kayitlar.get(yoklamaId(salon, saat));
  const onceki = oncekiYoklama(kayitlar, sinav.saatler, salon, saat);
  const yok = new Set(((mevcut || onceki)?.yoklar || []).map((x) => x.ogrenci_id));
  const ayniMi = () => onceki && yok.size === onceki.yoklar.length && onceki.yoklar.every((x) => yok.has(x.ogrenci_id));

  const kaydet = async (btn) => {
    btn.disabled = true;
    const hata = el.querySelector(".kb-yk-hata");
    hata.textContent = "";
    const kayit = {
      salon, saat, tur: ayniMi() ? "ayni" : "yeni", onceki_saat: onceki ? onceki.saat : null,
      yoklar: liste.filter((x) => yok.has(x.ogrenci_id)).map((x) => ({ ogrenci_id: x.ogrenci_id, no: x.no, ad: x.ad, sinif: x.sinif, ...(x.yerine ? { yerine: x.yerine } : {}) })),
      toplam: liste.length, mevcut: liste.length - yok.size,
      ogretmen_id: kim.id || "", ogretmen_ad: kim.ad || "", ogretmen_uid: auth.currentUser?.uid || "", zaman: serverTimestamp(),
    };
    try {
      await setDoc(doc(db, "kelebek_sinavlar", sinav.id, "yoklama", yoklamaId(salon, saat)), kayit);
      onKaydet({ ...kayit, zaman: null });
    } catch (err) {
      hata.textContent = "Kaydedilemedi: " + (err.code === "permission-denied" ? "Bu yoklamayı girme yetkiniz yok (yoklama sınav günü, kendi kaydınız için girilir)." : err.message);
      btn.disabled = false;
    }
  };

  const sayac = () => {
    el.querySelector(".kb-yk-sayac").innerHTML = `Mevcut: <strong>${liste.length - yok.size}</strong> · Yok: <strong style="color:${yok.size ? "#ea4335" : "inherit"};">${yok.size}</strong> · Toplam: ${liste.length}`;
    const ayni = el.querySelector(".kb-yk-ayni");
    if (ayni) ayni.disabled = !ayniMi();
  };

  el.innerHTML = `<div class="kb-yoklama">
    <div style="font-weight:700;margin-bottom:6px;">📝 ${esc(salon)} · ${saat}. ders yoklaması</div>
    ${onceki ? `<div class="kb-yk-onceki">
        <div>${onceki.saat}. ders yoklaması (${esc(onceki.ogretmen_ad || "")}): ${onceki.yoklar.length ? `<strong style="color:#ea4335;">${onceki.yoklar.length} yok</strong> — ${esc(yokMetni(onceki))}` : "<strong>eksik yok</strong>"}</div>
        <button class="btn btn-yesil kb-yk-ayni" style="margin-top:8px;width:100%;">✓ Değişiklik yok — ${onceki.saat}. ders yoklamasıyla aynı</button>
        <div style="font-size:12px;color:var(--text2);margin-top:4px;">Değişiklik varsa aşağıdan öğrencileri işaretleyip "Yoklamayı kaydet"e basın.</div></div>` : ""}
    ${mevcut ? `<div style="font-size:12px;color:var(--text2);margin-bottom:6px;">Kayıtlı yoklama düzeltiliyor.</div>` : ""}
    <div class="kb-yk-liste">${liste.map((x) => `<div class="kb-yk-satir${yok.has(x.ogrenci_id) ? " yok" : ""}" data-id="${esc(x.ogrenci_id)}">
        <span class="kb-yk-no">${x.sira != null ? x.sira + "." : ""}</span>
        <span style="flex:1;">${esc(x.no)} ${esc(x.ad)} <span class="rozet rozet-mavi" style="font-size:11px;">${esc(x.sinif)}</span>
          ${x.yerine ? `<div style="font-size:12px;color:#e65100;">🔁 Yerine girecek: <strong>${esc(x.yerine)}</strong></div>` : ""}</span>
        <button class="btn btn-sm kb-yk-btn">${yok.has(x.ogrenci_id) ? "✗ Yok" : "✓ Var"}</button></div>`).join("") || '<div class="bos-mesaj">Bu salonda öğrenci yok.</div>'}</div>
    <div class="kb-yk-sayac" style="margin:8px 0;"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-mavi kb-yk-kaydet">💾 Yoklamayı kaydet</button>
      <button class="btn btn-gri kb-yk-kapat">Kapat</button></div>
    <div class="kb-yk-hata" style="color:#ea4335;font-size:13px;margin-top:6px;"></div></div>`;

  el.querySelectorAll(".kb-yk-satir").forEach((satir) => {
    satir.querySelector(".kb-yk-btn").onclick = () => {
      const id = satir.dataset.id;
      yok.has(id) ? yok.delete(id) : yok.add(id);
      satir.classList.toggle("yok", yok.has(id));
      satir.querySelector(".kb-yk-btn").textContent = yok.has(id) ? "✗ Yok" : "✓ Var";
      sayac();
    };
  });
  el.querySelector(".kb-yk-ayni")?.addEventListener("click", (e) => kaydet(e.currentTarget));
  el.querySelector(".kb-yk-kaydet").onclick = (e) => kaydet(e.currentTarget);
  el.querySelector(".kb-yk-kapat").onclick = () => onKapat();
  sayac();
}
