import {
  db, auth, bugunHesapla,
  getDocs, getDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, normalizeGun } from "./portal-utils.js";

// ── YOKLAMA GİR (sadece admin) ──
// Admin her sinifa, istedigi gun ve ders saati icin saat/sure siniri olmadan
// yoklama girer. Kayit ogretmen "Manuel Giris" (portal-teacher.js manuelKaydet)
// ile ayni bicimde; ayni tarih+sinif+saatteki eski kayit silinip yenisi yazilir.
// daily_summary'yi attendanceYazildiginda tetikleyicisi yeniden hesaplar.

const GUNLER = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];

let _saatler = {};        // ders_saatleri/varsayilan.saatler: { "1": "08:30", ... }
let _yoklamalar = {};     // "sinif|dersNo" -> { id, absent_students } (secili tarih)
let _dersler = null;      // secili tarihin today_lessons kayitlari
let _program = null;      // schedule (tum hafta, ilk ihtiyacta)
let _dersListesi = null;  // ders_listesi adlari
let _acikSinif = null;

// Baslangici simdiden once olan en son ders; ilk dersten once 1.
export function suankiDersNo(saatler, simdi = new Date()) {
  const dk = simdi.getHours() * 60 + simdi.getMinutes();
  let secilen = 1;
  Object.entries(saatler || {})
    .map(([no, s]) => [Number(no), String(s).split(":").map(Number)])
    .filter(([no, [h, m]]) => no && !isNaN(h) && !isNaN(m))
    .sort((a, b) => a[0] - b[0])
    .forEach(([no, [h, m]]) => { if (h * 60 + m <= dk) secilen = no; });
  return secilen;
}

function kademe(sinifAdi) {
  const m = String(sinifAdi).match(/^\d+/);
  return m ? m[0] + ". Sınıflar" : "Diğer";
}

function ogretmenAd(id) {
  return state.ogretmenler.find((o) => o.id === id)?.ad || "";
}

export async function yoklamaGirYukle() {
  const kok = document.getElementById("ygSinifListesi");
  if (!kok) return;
  if (state.rol !== "admin") {
    kok.innerHTML = '<div class="bos-mesaj">Bu ekran sadece admin içindir.</div>';
    document.getElementById("ygUst").hidden = true;
    return;
  }
  const tarihEl = document.getElementById("ygTarih");
  const saatEl = document.getElementById("ygDersNo");
  try {
    const saatDoc = await getDoc(doc(db, "ders_saatleri", "varsayilan"));
    _saatler = saatDoc.exists() ? saatDoc.data().saatler || {} : {};
  } catch (e) {
    _saatler = {};
  }
  if (!tarihEl.value) tarihEl.value = bugunHesapla();
  if (!saatEl.dataset.ayarlandi) {
    saatEl.value = String(suankiDersNo(_saatler));
    saatEl.dataset.ayarlandi = "1";
  }
  await window.yoklamaGirSecimDegisti();
}
window.yoklamaGirYukle = yoklamaGirYukle;

// Tarih ya da saat degisti: o gunun yoklamalari + dersleri yeniden okunur.
window.yoklamaGirSecimDegisti = async () => {
  const kok = document.getElementById("ygSinifListesi");
  const tarih = document.getElementById("ygTarih").value;
  if (!tarih) { kok.innerHTML = '<div class="bos-mesaj">Tarih seçin.</div>'; return; }
  kok.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const [attSnap, dersSnap] = await Promise.all([
      getDocs(query(collection(db, "attendance"), where("date", "==", tarih))),
      getDocs(query(collection(db, "today_lessons"), where("date", "==", tarih))),
    ]);
    if (document.getElementById("ygTarih").value !== tarih) return;
    _yoklamalar = {};
    attSnap.forEach((d) => {
      const a = d.data();
      _yoklamalar[a.class_id + "|" + a.lesson_number] = { id: d.id, absent_students: a.absent_students || [] };
    });
    _dersler = [];
    dersSnap.forEach((d) => _dersler.push({ id: d.id, ...d.data() }));
    _acikSinif = null;
    _listeCiz();
  } catch (err) {
    kok.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
};

function _dersNo() {
  return Number(document.getElementById("ygDersNo").value);
}

function _rozet(sinif) {
  const y = _yoklamalar[sinif + "|" + _dersNo()];
  if (!y) return '<span class="rozet rozet-gri" style="font-size:11px;">Girilmedi</span>';
  return `<span class="rozet rozet-yesil" style="font-size:11px;">✓ Girildi${y.absent_students.length ? ` (${y.absent_students.length} yok)` : " (tam)"}</span>`;
}

function _listeCiz() {
  const kok = document.getElementById("ygSinifListesi");
  const siniflar = state.siniflar.map((s) => s.class_name).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "tr", { numeric: true }));
  if (!siniflar.length) { kok.innerHTML = '<div class="bos-mesaj">Sınıf tanımlı değil.</div>'; return; }
  const gruplar = {};
  siniflar.forEach((s) => (gruplar[kademe(s)] ||= []).push(s));
  kok.innerHTML = Object.entries(gruplar).map(([ad, liste]) => `
    <div class="akor-kademe-baslik" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">
      <span>${esc(ad)} <span style="font-size:12px;font-weight:400;color:var(--text2);">(${liste.length} sınıf)</span></span><span>▼</span>
    </div>
    <div style="margin-bottom:8px;">${liste.map((s) => `
      <div class="akor-sube-baslik" data-sinif="${esc(s)}" onclick="yoklamaGirSinifAc(this.dataset.sinif)">
        <span><strong>${esc(s)}</strong></span><span class="yg-rozet">${_rozet(s)}</span>
      </div>
      <div class="yg-sinif-icerik" data-sinif="${esc(s)}" hidden style="margin:0 0 10px 12px;"></div>`).join("")}
    </div>`).join("");
}

function _icerikEl(sinif) {
  return [...document.querySelectorAll("#ygSinifListesi .yg-sinif-icerik")].find((el) => el.dataset.sinif === sinif);
}

// O tarih+sinif+saat icin ders: once today_lessons, yoksa haftalik program.
async function _dersBul(tarih, sinif, dersNo) {
  const gunluk = (_dersler || []).find((d) => d.class_id === sinif && Number(d.lesson_number) === dersNo);
  if (gunluk) return { lesson_name: gunluk.lesson_name || "", teacher_id: gunluk.teacher_id || "" };
  if (!_program) {
    const snap = await getDocs(collection(db, "schedule"));
    _program = snap.docs.map((d) => d.data());
  }
  const gun = GUNLER[new Date(tarih + "T12:00:00").getDay()];
  const p = _program.find((d) => normalizeGun(d.day) === gun && d.class_id === sinif && Number(d.lesson_number) === dersNo);
  return p ? { lesson_name: p.lesson_name || "", teacher_id: p.teacher_id || "" } : null;
}

async function _dersListesiSecenekleri() {
  if (!_dersListesi) {
    const snap = await getDocs(collection(db, "ders_listesi"));
    _dersListesi = snap.docs.map((d) => d.data().ders_adi).filter(Boolean).sort((a, b) => a.localeCompare(b, "tr"));
  }
  return _dersListesi;
}

window.yoklamaGirSinifAc = async (sinif) => {
  const el = _icerikEl(sinif);
  if (!el) return;
  if (_acikSinif === sinif && !el.hidden) { el.hidden = true; _acikSinif = null; return; }
  if (_acikSinif) { const eski = _icerikEl(_acikSinif); if (eski) eski.hidden = true; }
  _acikSinif = sinif;
  el.hidden = false;
  el.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const tarih = document.getElementById("ygTarih").value;
  const dersNo = _dersNo();
  try {
    const [ogrSnap, ders] = await Promise.all([
      getDocs(query(collection(db, "students"), where("class_id", "==", sinif), where("status", "==", "active"))),
      _dersBul(tarih, sinif, dersNo),
    ]);
    const ogrenciler = ogrSnap.docs.map((d) => d.data())
      .sort((a, b) => String(a.student_number).localeCompare(String(b.student_number), "tr", { numeric: true }));
    const yoklar = new Set((_yoklamalar[sinif + "|" + dersNo]?.absent_students || []).map(String));

    let dersHtml;
    if (ders && ders.lesson_name) {
      dersHtml = `<div style="font-size:13px;margin-bottom:8px;"><strong>${dersNo}. ders:</strong> ${esc(ders.lesson_name)}${ders.teacher_id ? ` <span style="color:var(--text2);">· ${esc(ogretmenAd(ders.teacher_id))}</span>` : ""}
        <input type="hidden" class="yg-ders-adi" value="${esc(ders.lesson_name)}" data-ogretmen="${esc(ders.teacher_id || "")}"></div>`;
    } else {
      const adlar = await _dersListesiSecenekleri();
      dersHtml = `<div class="form-group" style="margin-bottom:8px;"><label>${dersNo}. ders — programda ders yok, ders adını seçin</label>
        <select class="yg-ders-adi" data-ogretmen=""><option value="">Ders seçin...</option>${adlar.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("")}</select></div>`;
    }

    el.innerHTML = `${dersHtml}
      <div class="uyari-kutu-sm">Gelmeyen öğrencileri işaretleyin${yoklar.size || _yoklamalar[sinif + "|" + dersNo] ? " (kayıtlı yoklama yüklendi)" : ""}</div>
      ${ogrenciler.length ? ogrenciler.map((o) => {
        const no = String(o.student_number);
        const yok = yoklar.has(no);
        return `<label class="ogrenci-satir${yok ? " yok" : ""}" style="cursor:pointer;">
          <input type="checkbox" class="yg-chk" value="${esc(no)}"${yok ? " checked" : ""} onchange="this.parentElement.classList.toggle('yok', this.checked)">
          <span class="ogrenci-no">${esc(no)}</span><span class="ogrenci-isim">${esc(o.name)}</span></label>`;
      }).join("") : '<div class="bos-mesaj">Bu sınıfta aktif öğrenci yok.</div>'}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button class="btn btn-yesil" onclick="yoklamaGirKaydet(this.dataset.sinif, false)" data-sinif="${esc(sinif)}">Kaydet</button>
        <button class="btn btn-mavi" onclick="yoklamaGirKaydet(this.dataset.sinif, true)" data-sinif="${esc(sinif)}">✓ Sınıf Tam</button>
      </div>
      <div class="mesaj yg-mesaj" style="margin-top:8px;"></div>`;
  } catch (err) {
    el.innerHTML = `<div class="bos-mesaj">Yüklenemedi: ${esc(err.message)}</div>`;
  }
};

window.yoklamaGirKaydet = async (sinif, tam) => {
  const el = _icerikEl(sinif);
  if (!el) return;
  const mesajEl = el.querySelector(".yg-mesaj");
  const goster = (metin, tip) => {
    mesajEl.textContent = metin;
    mesajEl.className = "mesaj yg-mesaj mesaj-" + tip;
    mesajEl.style.display = "block";
  };
  const tarih = document.getElementById("ygTarih").value;
  const dersNo = _dersNo();
  const dersEl = el.querySelector(".yg-ders-adi");
  const dersAdi = dersEl?.value.trim();
  if (!tarih || !dersAdi) { goster("Ders adını seçin.", "hata"); return; }

  if (tam) el.querySelectorAll(".yg-chk").forEach((c) => { c.checked = false; c.parentElement.classList.remove("yok"); });
  const yoklar = [...el.querySelectorAll(".yg-chk:checked")].map((c) => c.value);
  const ogretmenId = dersEl.dataset.ogretmen || "manuel";
  const butonlar = el.querySelectorAll("button");
  butonlar.forEach((b) => (b.disabled = true));
  try {
    const eskiSnap = await getDocs(query(collection(db, "attendance"),
      where("date", "==", tarih), where("class_id", "==", sinif), where("lesson_number", "==", dersNo)));
    await Promise.all(eskiSnap.docs.map((d) => deleteDoc(d.ref)));
    const ref = await addDoc(collection(db, "attendance"), {
      date: tarih,
      class_id: sinif,
      lesson_number: dersNo,
      lesson_name: dersAdi,
      teacher_id: ogretmenId,
      actual_teacher: "manuel",
      absent_students: yoklar,
      created_at: serverTimestamp(),
      entered_at: serverTimestamp(),
      is_late_entry: true,
      is_manual: true,
      locked: true,
      giren_uid: auth.currentUser?.uid || null,
      giren_ad: state.kullanici?.ad || "admin",
    });
    const dersSnap = await getDocs(query(collection(db, "today_lessons"),
      where("date", "==", tarih), where("class_id", "==", sinif), where("lesson_number", "==", dersNo)));
    await Promise.all(dersSnap.docs.map((d) => updateDoc(d.ref, { status: "filled" }).catch(() => {})));

    _yoklamalar[sinif + "|" + dersNo] = { id: ref.id, absent_students: yoklar };
    const baslik = [...document.querySelectorAll("#ygSinifListesi .akor-sube-baslik")].find((b) => b.dataset.sinif === sinif);
    if (baslik) baslik.querySelector(".yg-rozet").innerHTML = _rozet(sinif);
    goster(yoklar.length ? `Kaydedildi: ${yoklar.length} öğrenci yok.` : "Kaydedildi: sınıf tam.", "basari");
  } catch (err) {
    goster("Hata: " + err.message, "hata");
  }
  butonlar.forEach((b) => (b.disabled = false));
};

// Saat degisince sadece rozetler ve acik sinif yenilenir (tarih ayni).
window.yoklamaGirSaatDegisti = () => {
  if (!_dersler) return;
  const acik = _acikSinif;
  _listeCiz();
  _acikSinif = null;
  if (acik) window.yoklamaGirSinifAc(acik);
};
