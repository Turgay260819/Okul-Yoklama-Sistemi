import {
  db, functions, bugun,
  getDocs, addDoc, updateDoc, deleteDoc, getDoc,
  collection, query, where, doc, serverTimestamp, httpsCallable,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, sor_giris } from "./portal-utils.js";
import { OGRETMEN_REFRESH_MS } from "./portal-config.js";

// ── ANASAYFA ──
export async function anasayfaYukle() {
  try {
    const snap = await getDocs(
      query(collection(db, "today_lessons"), where("date", "==", bugun)),
    );
    let girilen = 0, eksik = 0;
    const durumlar = [];
    snap.forEach((d) => {
      const data = d.data();
      if (data.status === "filled") girilen++;
      else eksik++;
      durumlar.push(data);
    });
    document.getElementById("statToplamDers").textContent = snap.size;
    document.getElementById("statGirilenYoklama").textContent = girilen;
    document.getElementById("statEksikYoklama").textContent = eksik;

    const summSnap = await getDocs(
      query(collection(db, "daily_summary"), where("date", "==", bugun)),
    );
    let tamGun = 0;
    summSnap.forEach((d) => { if (d.data().status === "full_day_absent") tamGun++; });
    document.getElementById("statTamGun").textContent = tamGun;

    if (!durumlar.length) {
      document.getElementById("bugunDurum").innerHTML =
        '<div class="bos-mesaj">Bugün için ders programı oluşturulmamış</div>';
    } else {
      document.getElementById("bugunDurum").innerHTML = _bugunDurumHtml(durumlar);
    }

    await window.ogretmenTakipYukle();
    if (state.takipInterval) clearInterval(state.takipInterval);
    state.takipInterval = setInterval(() => window.ogretmenTakipYukle(), OGRETMEN_REFRESH_MS);
  } catch (err) {
    console.error("Anasayfa yükleme hatası:", err);
  }
}
window.anasayfaYukle = anasayfaYukle;

function _bugunDurumHtml(durumlar) {
  const ogretmenIdMap = {};
  state.ogretmenler.forEach((o) => (ogretmenIdMap[o.id] = o.ad));

  const kademeGruplari = {};
  durumlar.forEach((d) => {
    const kademe = (d.class_id || "?").match(/\d+/)?.[0] || "?";
    if (!kademeGruplari[kademe]) kademeGruplari[kademe] = {};
    if (!kademeGruplari[kademe][d.class_id]) kademeGruplari[kademe][d.class_id] = [];
    kademeGruplari[kademe][d.class_id].push(d);
  });

  let html = "";
  Object.keys(kademeGruplari).sort((a, b) => parseInt(a) - parseInt(b)).forEach((kademe) => {
    const subeler = kademeGruplari[kademe];
    const kademeId = "akor-k" + kademe;
    let kToplam = 0, kDolu = 0;
    Object.values(subeler).forEach((dersler) =>
      dersler.forEach((d) => { kToplam++; if (d.status === "filled") kDolu++; }),
    );
    const kEksik = kToplam - kDolu;
    const kRozet = kEksik === 0
      ? '<span class="rozet rozet-yesil" style="font-size:11px;">Tamam</span>'
      : `<span class="rozet rozet-kirmizi" style="font-size:11px;">${kEksik} Eksik</span>`;

    html += `<div style="margin-bottom:4px;">
      <div class="akor-kademe-baslik" onclick="akordiyonToggle('${kademeId}')">
        <span>📚 ${kademe}. Sınıflar <span style="font-size:12px;font-weight:400;color:var(--text2);">(${Object.keys(subeler).length} şube)</span></span>
        <span style="display:flex;gap:8px;align-items:center;">${kRozet} <span id="ok-${kademeId}" style="font-size:12px;color:var(--text2);">▶</span></span>
      </div>
      <div id="${kademeId}" style="display:none;padding-left:8px;margin-top:2px;">`;

    Object.keys(subeler).sort().forEach((sube) => {
      const dersler = subeler[sube].sort((a, b) => a.lesson_number - b.lesson_number);
      const subeId = "akor-s" + sube.replace(/[^a-zA-Z0-9]/g, "");
      const dolu = dersler.filter((d) => d.status === "filled").length;
      const subeEksik = dersler.length - dolu;
      const subeRozet = subeEksik === 0
        ? '<span class="rozet rozet-yesil" style="font-size:11px;">Tamam</span>'
        : `<span class="rozet rozet-kirmizi" style="font-size:11px;">${subeEksik} Eksik</span>`;

      html += `<div style="margin-bottom:3px;">
        <div class="akor-sube-baslik" onclick="akordiyonToggle('${subeId}')">
          <span>🏫 ${esc(sube)}</span>
          <span style="display:flex;gap:8px;align-items:center;"><span style="font-size:12px;color:var(--text2);">${dolu}/${dersler.length}</span>${subeRozet} <span id="ok-${subeId}" style="font-size:12px;color:var(--text2);">▶</span></span>
        </div>
        <div id="${subeId}" style="display:none;padding:6px 0 6px 12px;">
          <table style="width:100%;font-size:13px;"><tbody>`;
      dersler.forEach((d) => {
        const ogretmenAd = esc(ogretmenIdMap[d.teacher_id] || "-");
        const droz = d.status === "filled"
          ? '<span class="rozet rozet-yesil" style="font-size:11px;">Girildi</span>'
          : '<span class="rozet rozet-kirmizi" style="font-size:11px;">Eksik</span>';
        html += `<tr>
          <td style="padding:4px 8px 4px 0;color:var(--text2);white-space:nowrap;">${d.lesson_number}. Ders</td>
          <td style="padding:4px 6px;">${esc(d.lesson_name || "-")}</td>
          <td style="padding:4px 6px;color:var(--text2);font-size:12px;">${ogretmenAd}</td>
          <td style="padding:4px 0;text-align:right;">${droz}</td>
        </tr>`;
      });
      html += `</tbody></table></div></div>`;
    });
    html += `</div></div>`;
  });
  return html;
}

// ── ÖĞRETMEN TAKİP ──
window.ogretmenTakipYukle = async function () {
  const container = document.getElementById("ogretmenTakipListesi");
  const ozetEl = document.getElementById("ogretmenTakipOzet");
  if (!container) return;
  container.innerHTML = '<div class="yukleniyor">Yükleniyor...</div>';

  try {
    const [lessonsSnap, devamSnap] = await Promise.all([
      getDocs(query(collection(db, "today_lessons"), where("date", "==", bugun))),
      getDocs(query(collection(db, "ogretmen_devam"), where("tarih", "==", bugun))),
    ]);

    if (lessonsSnap.empty) {
      container.innerHTML = '<div class="bos-mesaj">Bugün için ders programı oluşturulmamış.</div>';
      if (ozetEl) ozetEl.innerHTML = "";
      return;
    }

    const devamMap = {};
    devamSnap.forEach((d) => { const v = d.data(); devamMap[v.ogretmen_id] = v; });

    const ogretmenMap = {};
    state.ogretmenler.forEach((o) => (ogretmenMap[o.id] = o));

    const kademeGrup = {};
    const benzersizOgretmenler = new Set();
    lessonsSnap.forEach((d) => {
      const data = d.data();
      const tid = data.teacher_id;
      if (!tid) return;
      benzersizOgretmenler.add(tid);
      const kademe = (data.class_id || "?").match(/\d+/)?.[0] || "?";
      if (!kademeGrup[kademe]) kademeGrup[kademe] = {};
      if (!kademeGrup[kademe][tid]) {
        kademeGrup[kademe][tid] = {
          ad: ogretmenMap[tid]?.ad || tid,
          dersler: [],
          devam: devamMap[tid] || null,
        };
      }
      kademeGrup[kademe][tid].dersler.push({
        lesson_number: data.lesson_number,
        lesson_name: data.lesson_name || "-",
        class_id: data.class_id,
      });
    });

    if (ozetEl) {
      const gelmediSayisi = Object.values(devamMap).filter((v) => v.durum === "gelmedi").length;
      const gecSayisi = Object.values(devamMap).filter((v) => v.durum === "gec").length;
      ozetEl.innerHTML =
        `<div class="ozet-pill">👨‍🏫 ${benzersizOgretmenler.size} öğretmen</div>` +
        (gelmediSayisi ? `<div class="ozet-pill ozet-pill-kirmizi">🚫 ${gelmediSayisi} gelmedi</div>` : "") +
        (gecSayisi ? `<div class="ozet-pill ozet-pill-turuncu">⚠️ ${gecSayisi} geç geldi</div>` : "");
    }

    let html = "";
    Object.keys(kademeGrup).sort((a, b) => parseInt(a) - parseInt(b)).forEach((kademe) => {
      const ogretmenler = kademeGrup[kademe];
      const kademeId = "takip-k" + kademe;
      const gelmediSayisi = Object.values(ogretmenler).filter((o) => o.devam?.durum === "gelmedi").length;
      const gecSayisi = Object.values(ogretmenler).filter((o) => o.devam?.durum === "gec").length;
      const kRozet = gelmediSayisi
        ? `<span class="rozet rozet-kirmizi" style="font-size:11px;">${gelmediSayisi} Gelmedi</span>`
        : gecSayisi ? `<span class="rozet rozet-sari" style="font-size:11px;">${gecSayisi} Geç</span>` : "";

      html += `<div style="margin-bottom:4px;">
        <div class="akor-kademe-baslik" onclick="akordiyonToggle('${kademeId}')">
          <span>👨‍🏫 ${kademe}. Sınıflar <span style="font-size:12px;font-weight:400;color:var(--text2);">(${Object.keys(ogretmenler).length} öğretmen)</span></span>
          <span style="display:flex;gap:8px;align-items:center;">${kRozet} <span id="ok-${kademeId}" style="font-size:12px;color:var(--text2);">▶</span></span>
        </div>
        <div id="${kademeId}" style="display:none;padding:4px 0 4px 8px;">`;

      Object.entries(ogretmenler)
        .sort(([, a], [, b]) => a.ad.localeCompare(b.ad, "tr"))
        .forEach(([tid, ogr]) => {
          const derslerStr = ogr.dersler
            .sort((a, b) => a.lesson_number - b.lesson_number)
            .map((d) => `${d.lesson_number}. Ders — ${esc(d.lesson_name)} (${esc(d.class_id)})`)
            .join(", ");
          const devam = ogr.devam;
          let durumHtml;
          if (devam?.durum === "gelmedi") {
            durumHtml = `<span class="rozet rozet-kirmizi" style="font-size:11px;">Gelmedi</span> <button class="btn btn-gri btn-sm" style="font-size:11px;padding:4px 8px;" onclick="devamDegistir('${tid}')">Değiştir</button>`;
          } else if (devam?.durum === "gec") {
            durumHtml = `<span class="rozet rozet-turuncu" style="font-size:11px;">Geç: ${esc(devam.gec_saat || "")}</span> <button class="btn btn-gri btn-sm" style="font-size:11px;padding:4px 8px;" onclick="devamDegistir('${tid}')">Değiştir</button>`;
          } else if (devam?.durum === "geldi") {
            durumHtml = `<span class="rozet rozet-yesil" style="font-size:11px;">Geldi</span> <button class="btn btn-gri btn-sm" style="font-size:11px;padding:4px 8px;" onclick="devamDegistir('${tid}')">Değiştir</button>`;
          } else {
            durumHtml = `<button class="btn btn-kirmizi btn-sm" style="font-size:11px;padding:4px 8px;" onclick="devamIsaretle('${tid}','gelmedi')">Gelmedi</button> <button class="btn btn-turuncu btn-sm" style="font-size:11px;padding:4px 8px;" onclick="devamGecSor('${tid}')">Geç Geldi</button>`;
          }
          html += `<div class="takip-satir">
            <span style="font-weight:600;min-width:120px;">${esc(ogr.ad)}</span>
            <span style="flex:1;font-size:12px;color:var(--text2);">${derslerStr}</span>
            <span style="display:flex;gap:4px;align-items:center;flex-shrink:0;">${durumHtml}</span>
          </div>`;
        });

      html += `</div></div>`;
    });

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="bos-mesaj" style="color:#ea4335;">Hata: ${esc(err.message)}</div>`;
  }
};

window.devamIsaretle = async (tid, durum, gecSaat) => {
  const ogr = state.ogretmenler.find((o) => o.id === tid);
  const veri = { ogretmen_id: tid, ogretmen_ad: ogr?.ad || "", tarih: bugun, durum };
  if (gecSaat) veri.gec_saat = gecSaat;
  const mevcutSnap = await getDocs(
    query(collection(db, "ogretmen_devam"), where("tarih", "==", bugun), where("ogretmen_id", "==", tid)),
  );
  if (!mevcutSnap.empty) {
    await updateDoc(mevcutSnap.docs[0].ref, veri);
  } else {
    await addDoc(collection(db, "ogretmen_devam"), { ...veri, olusturulma: serverTimestamp() });
  }
  window.ogretmenTakipYukle();
};

window.devamGecSor = async (tid) => {
  const { sor_giris: sorGiris } = await import("./portal-utils.js");
  const saat = await sorGiris("Geç Geliş Saati", "Geç geliş saatini girin:", "orn: 09:15");
  if (saat) window.devamIsaretle(tid, "gec", saat);
};

window.devamDegistir = async (tid) => {
  const { sor_giris: sorGiris } = await import("./portal-utils.js");
  const secim = await sorGiris("Devam Durumu", "Yeni durum girin:", "geldi / gec / gelmedi");
  if (!secim) return;
  const temiz = secim.trim().toLowerCase();
  if (temiz === "gec") { window.devamGecSor(tid); return; }
  if (["geldi", "gelmedi"].includes(temiz)) window.devamIsaretle(tid, temiz);
};

// ── YOKLAMA ADMİN ──
window.yoklamalariGetir = async () => {
  const tarih = document.getElementById("yoklamaTarih").value;
  const container = document.getElementById("yoklamaListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(
    query(collection(db, "attendance"), where("date", "==", tarih)),
  );
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Bu tarihte yoklama kaydi yok</div>';
    return;
  }
  let html = "<table><thead><tr><th>Sinif</th><th>Ders</th><th>Ogretmen</th><th>Eksik</th><th>Giris Tipi</th></tr></thead><tbody>";
  snap.forEach((d) => {
    const data = d.data();
    const ogr = state.ogretmenler.find((o) => o.id === data.actual_teacher);
    const girisTipi = data.is_manual
      ? '<span class="rozet rozet-sari">Manuel</span>'
      : '<span class="rozet rozet-yesil">Normal</span>';
    html += `<tr><td>${esc(data.class_id)}</td><td>${data.lesson_number}. Ders</td><td>${esc(ogr?.ad || "-")}</td><td>${data.absent_students?.length || 0}</td><td>${girisTipi}</td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
};

// ── DYK ADMİN ──
window.dykAdminYukle = async function () {
  const tarih = document.getElementById("dykAdminTarih").value;
  const container = document.getElementById("dykAdminListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(
    query(collection(db, "dyk_attendance"), where("date", "==", tarih)),
  );
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Bu tarihte DYK yoklama kaydi yok.</div>';
    return;
  }
  let html = "<table><thead><tr><th>Sinif</th><th>Kurs</th><th>Ogretmen</th><th>Eksik</th><th>Giris</th></tr></thead><tbody>";
  snap.forEach((d) => {
    const data = d.data();
    const ogr = state.ogretmenler.find((o) => o.id === data.teacher_id);
    const tip = data.is_manual
      ? '<span class="rozet rozet-sari">Manuel</span>'
      : '<span class="rozet rozet-yesil">Normal</span>';
    html += `<tr><td>${esc(data.class_id || "-")}</td><td>${esc(data.course_name || data.course_id)}</td><td>${esc(ogr?.ad || "-")}</td><td>${data.absent_students?.length || 0}</td><td>${tip}</td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
};

// ── MANUEL DERS OLUŞTUR ──
window.manuelDersOlustur = async () => {
  mesajGoster("dersOlusturMesaj", "Olusturuluyor...", "bilgi");
  try {
    const fn = httpsCallable(functions, "manuelDersOlustur");
    const r = await fn({ tarih: bugun });
    mesajGoster("dersOlusturMesaj", r.data.message, "basari");
    anasayfaYukle();
  } catch (err) {
    mesajGoster("dersOlusturMesaj", "Hata: " + err.message, "hata");
  }
};
