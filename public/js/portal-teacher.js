import {
  db, bugun, YOKLAMA_PENCERE_DK,
  getDocs, addDoc, updateDoc, deleteDoc, getDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, haftaNoHesapla } from "./portal-utils.js";

const GUNLER = ["Pazar", "Pazartesi", "Sali", "Carsamba", "Persembe", "Cuma", "Cumartesi"];

// ── DERSLERİM ──
export async function dersleriniYukle() {
  const container = document.getElementById("dersListesi");
  const baslikEl = document.getElementById("bugunTarihBaslik");
  if (baslikEl) baslikEl.textContent =
    GUNLER[new Date().getDay()] + ", " +
    new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const snap = await getDocs(
    query(collection(db, "today_lessons"), where("date", "==", bugun)),
  );
  let dersler = [];
  snap.forEach((d) => {
    const data = { id: d.id, ...d.data() };
    if (!state.ogretmenDoc || data.teacher_id === state.ogretmenDoc.id) dersler.push(data);
  });

  if (!dersler.length) {
    container.innerHTML = '<div class="bos-mesaj">Bugun icin atanmis dersiniz yok.</div>';
    return;
  }
  dersler.sort((a, b) => a.lesson_number - b.lesson_number);

  // Kazanım cache
  const cacheKey = "kazanim_cache_" + bugun + "_" + (state.ogretmenDoc?.id || "");
  let kazanimOnbellek = {}, haftaNo = null;
  const cachedStr = sessionStorage.getItem(cacheKey);
  if (cachedStr) {
    try { const cached = JSON.parse(cachedStr); kazanimOnbellek = cached.kazanimOnbellek || {}; haftaNo = cached.haftaNo; } catch {}
  } else {
    try {
      const takvimSnap = await getDocs(collection(db, "kazanim_takvim"));
      if (!takvimSnap.empty) {
        const takvim = takvimSnap.docs[0].data();
        if (takvim.baslangic_tarihi) {
          const [tatilSnap] = await Promise.all([getDocs(collection(db, "kazanim_tatil"))]);
          const tatiller = [];
          tatilSnap.forEach((d) => tatiller.push(d.data()));
          haftaNo = haftaNoHesapla(takvim.baslangic_tarihi, bugun, tatiller);
          if (haftaNo) {
            const kombinasyonlar = new Map();
            dersler.forEach((d) => {
              const seviye = parseInt(d.class_id.charAt(0));
              if (!seviye || !d.lesson_name) return;
              const key = seviye + "|" + d.lesson_name;
              if (!kombinasyonlar.has(key)) kombinasyonlar.set(key, { seviye, dersAdi: d.lesson_name });
            });
            // Paralel sorgular: tüm kombinasyonları aynı anda sorgula
            const kombEntries = [...kombinasyonlar.entries()];
            const sonuclar = await Promise.all(
              kombEntries.map(([, k]) =>
                Promise.all([
                  getDocs(query(collection(db, "kazanim_dersler"), where("ders_adi", "==", k.dersAdi), where("sinif_seviyesi", "==", k.seviye))),
                ])
              )
            );
            const kazSnap2Arr = await Promise.all(
              kombEntries.map(([, k], i) => {
                const dersSnap = sonuclar[i][0];
                if (dersSnap.empty) return null;
                return getDocs(query(collection(db, "kazanim_listesi"), where("ders_id", "==", dersSnap.docs[0].id), where("hafta_no", "==", haftaNo)));
              })
            );
            kombEntries.forEach(([key], i) => {
              const kaz = kazSnap2Arr[i];
              if (kaz && !kaz.empty) kazanimOnbellek[key] = { metin: kaz.docs[0].data().kazanim, hafta: haftaNo };
            });
            sessionStorage.setItem(cacheKey, JSON.stringify({ kazanimOnbellek, haftaNo }));
          }
        }
      }
    } catch {}
  }

  // Yoklama durumları
  const yoklamaSnap = await getDocs(
    query(collection(db, "attendance"), where("date", "==", bugun)),
  );
  const yoklamaSet = new Set();
  yoklamaSnap.forEach((d) => {
    const data = d.data();
    yoklamaSet.add(data.class_id + "|" + data.lesson_number);
  });

  // Kazanım kartı
  const gosterilecekKazanimlar = new Map();
  dersler.forEach((d) => {
    const seviye = parseInt(d.class_id.charAt(0));
    const key = seviye + "|" + d.lesson_name;
    const kazanim = kazanimOnbellek[key];
    if (!kazanim) return;
    if (!gosterilecekKazanimlar.has(key)) {
      gosterilecekKazanimlar.set(key, { dersAdi: d.lesson_name, seviye, metin: kazanim.metin, hafta: kazanim.hafta, siniflar: [] });
    }
    if (!gosterilecekKazanimlar.get(key).siniflar.includes(d.class_id)) {
      gosterilecekKazanimlar.get(key).siniflar.push(d.class_id);
    }
  });

  let html = "";
  if (gosterilecekKazanimlar.size > 0) {
    html += `<div class="kazanim-kart-haftasi">
      <div class="kazanim-kart-baslik">Bu Haftanin Kazanimlari — ${haftaNo || "?"}. Hafta</div>`;
    for (const [, k] of gosterilecekKazanimlar) {
      const sinifStr = [...k.siniflar].sort().join(", ");
      html += `<div class="kazanim-ders-item">
        <div class="kazanim-ders-baslik">${k.seviye}. Sinif ${esc(k.dersAdi)} — ${esc(sinifStr)}</div>
        <div class="kazanim-ders-metin">${esc(k.metin)}</div>
      </div>`;
    }
    html += `</div>`;
  }

  // Ders kartları
  const gruplar = new Map();
  dersler.forEach((d) => {
    const key = d.class_id + "|" + d.lesson_name;
    if (!gruplar.has(key)) gruplar.set(key, []);
    gruplar.get(key).push(d);
  });
  const siraliGruplar = [...gruplar.entries()].sort(
    (a, b) => Math.min(...a[1].map((d) => d.lesson_number)) - Math.min(...b[1].map((d) => d.lesson_number)),
  );

  for (const [, grup] of siraliGruplar) {
    const ilkDers = grup[0];
    const sinif = ilkDers.class_id;
    const dersAdi = ilkDers.lesson_name || "-";
    const dersNolari = grup.map((d) => d.lesson_number).sort((a, b) => a - b);
    const dersNoStr = dersNolari.join(". ve ") + ". Ders";
    const hepsiGirildi = grup.every((d) => yoklamaSet.has(d.class_id + "|" + d.lesson_number));
    const biriBileGirildi = grup.some((d) => yoklamaSet.has(d.class_id + "|" + d.lesson_number));

    let rozetHtml, kartSinif;
    if (hepsiGirildi) {
      rozetHtml = '<span class="rozet-durum rozet-durum-tamam">✓ Yoklama Girildi</span>';
      kartSinif = "ders-kart";
    } else if (biriBileGirildi) {
      rozetHtml = '<span class="rozet-durum rozet-durum-kismi">◑ Kısmen Girildi</span>';
      kartSinif = "ders-kart eksik";
    } else {
      rozetHtml = '<span class="rozet-durum rozet-durum-bekliyor">! Yoklama Bekleniyor</span>';
      kartSinif = "ders-kart eksik";
    }

    html += `<div class="${kartSinif}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div class="ders-bilgi-baslik">${esc(sinif)} — ${esc(dersAdi)}</div>
          <div class="ders-bilgi-alt" style="margin-top:4px;">${dersNoStr}</div>
        </div>
        <div>${rozetHtml}</div>
      </div>
    </div>`;
  }

  if (!html) html = '<div class="bos-mesaj">Bugun icin atanmis dersiniz yok.</div>';
  container.innerHTML = html;
}
window.dersleriniYukle = dersleriniYukle;

// ── YOKLAMALARİM — zaman kilitli ──
window.yoklamalarimYukle = async function () {
  const container = document.getElementById("yoklamalarimListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  if (state.ymTimer) { clearInterval(state.ymTimer); state.ymTimer = null; }

  const saatDoc = await getDoc(doc(db, "ders_saatleri", "varsayilan"));
  state.ymSaatler = saatDoc.exists() ? saatDoc.data().saatler || {} : {};

  const snap = await getDocs(
    query(collection(db, "today_lessons"), where("date", "==", bugun)),
  );
  state.ymDersler = [];
  snap.forEach((d) => {
    const data = { id: d.id, ...d.data() };
    if (!state.ogretmenDoc || data.teacher_id === state.ogretmenDoc.id) state.ymDersler.push(data);
  });
  state.ymDersler.sort((a, b) => a.lesson_number - b.lesson_number);

  if (!state.ymDersler.length) {
    container.innerHTML = '<div class="bos-mesaj">Bugun icin dersiniz yok.</div>';
    return;
  }

  const attSnap = await getDocs(
    query(collection(db, "attendance"), where("date", "==", bugun)),
  );
  const girilmisSet = new Set();
  attSnap.forEach((d) => {
    const att = d.data();
    girilmisSet.add(att.class_id + "|" + att.lesson_number);
  });

  let html = "";
  for (const ders of state.ymDersler) {
    const key = ders.class_id + "|" + ders.lesson_number;
    if (girilmisSet.has(key)) continue;

    const saatStr = state.ymSaatler[ders.lesson_number] || "";
    const kartId = "ym_" + ders.class_id.replace(/[^a-zA-Z0-9]/g, "") + "_" + ders.lesson_number;

    html += `<div class="ders-kart" id="${kartId}"><div style="width:100%;">
      <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px;" onclick="ymAkordiyon('${kartId}')">
        <div style="flex:1;min-width:0;">
          <div class="ders-bilgi-baslik">${esc(ders.class_id)} — ${esc(ders.lesson_name || "-")}</div>
          <div class="ders-bilgi-alt" style="margin-top:4px;">${ders.lesson_number}. Ders${saatStr ? " • " + saatStr : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <span id="badge_${kartId}" style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"></span>
          <span id="ok_${kartId}" style="font-size:18px;color:var(--mavi);transition:transform 0.2s;">▼</span>
        </div>
      </div>
      <div id="panel_${kartId}" style="display:none;margin-top:12px;">
        <div id="uyari_${kartId}" style="border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;"></div>`;

    const ogrSnap = await getDocs(
      query(collection(db, "students"), where("class_id", "==", ders.class_id)),
    );
    const ogrenciler = [];
    ogrSnap.forEach((d) => ogrenciler.push({ id: d.id, ...d.data() }));
    ogrenciler.sort((a, b) => (a.name || "").localeCompare(b.name || "", "tr"));

    if (ogrenciler.length) {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-bottom:10px;">';
      ogrenciler.forEach((ogr) => {
        const chkId = "ymchk_" + ders.class_id + "_" + ders.lesson_number + "_" + ogr.id;
        html += `<label class="ogrenci-label"><input type="checkbox" id="${chkId}" value="${esc(ogr.student_number || ogr.id)}" style="width:16px;height:16px;"><span>${esc(ogr.name || "")}</span></label>`;
      });
      html += "</div>";
    } else {
      html += '<div style="color:#888;font-size:13px;">Ogrenci bulunamadi.</div>';
    }

    const dersAdiEsc = (ders.lesson_name || "").replace(/'/g, "\\'");
    html += `<div style="display:flex;gap:8px;">
        <button id="ymBtn_${kartId}" class="btn btn-yesil btn-sm" onclick="yoklamalarimKaydet('${ders.id}','${esc(ders.class_id)}',${ders.lesson_number},'${esc(ders.teacher_id || "")}','${dersAdiEsc}')">💾 Kaydet</button>
        <button class="btn btn-gri btn-sm" onclick="ymTumunuSec('${esc(ders.class_id)}',${ders.lesson_number})">Tumunu Sec</button>
      </div>
      <div id="ymMesaj_${esc(ders.class_id)}_${ders.lesson_number}" style="font-size:13px;margin-top:6px;"></div>
    </div></div></div>`;
  }

  if (!html) {
    html = '<div class="ym-tamam">✓ Bugunun tum yoklamalari girildi!</div>';
  }
  container.innerHTML = html;
  _ymZamanGuncelle();
  state.ymTimer = setInterval(_ymZamanGuncelle, 30000);
};

function _ymZamanGuncelle() {
  const simdi = new Date();
  const simdiDk = simdi.getHours() * 60 + simdi.getMinutes();
  for (const ders of state.ymDersler) {
    const kartId = "ym_" + ders.class_id.replace(/[^a-zA-Z0-9]/g, "") + "_" + ders.lesson_number;
    const kart = document.getElementById(kartId);
    if (!kart || kart.style.display === "none") continue;
    const saatStr = state.ymSaatler[ders.lesson_number];
    const badge = document.getElementById("badge_" + kartId);
    const uyari = document.getElementById("uyari_" + kartId);
    const panel = document.getElementById("panel_" + kartId);
    const ok = document.getElementById("ok_" + kartId);

    if (!saatStr) {
      if (badge) { badge.textContent = "Acik"; badge.style.cssText = "background:#e6f4ea;color:#1e7e34;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
      if (panel && panel.style.display === "none") { panel.style.display = "block"; if (ok) ok.style.transform = ""; }
      continue;
    }
    const [saat, dakika] = saatStr.split(":").map(Number);
    const baslamaDk = saat * 60 + dakika;
    const bitimDk = baslamaDk + YOKLAMA_PENCERE_DK;
    if (simdiDk < baslamaDk) {
      const fark = baslamaDk - simdiDk;
      kart.style.opacity = "0.7"; kart.style.pointerEvents = "none";
      if (panel) { panel.style.display = "none"; if (ok) ok.style.transform = "rotate(180deg)"; }
      if (badge) { badge.textContent = "⏰ " + fark + " dk sonra"; badge.style.cssText = "background:#f1f3f4;color:#5f6368;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
    } else if (simdiDk <= bitimDk) {
      const kalan = bitimDk - simdiDk;
      kart.style.opacity = "1"; kart.style.pointerEvents = ""; kart.style.borderLeft = "4px solid var(--yesil)";
      if (panel && panel.style.display === "none") { panel.style.display = "block"; if (ok) ok.style.transform = ""; }
      if (badge) { badge.textContent = "⏱ " + kalan + " dk kaldi"; badge.style.cssText = "background:#fff3e0;color:#e65100;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
      if (uyari) { uyari.textContent = "Gelmeyen ogrencileri isaretleyin. " + kalan + " dakika icinde kaydedin."; uyari.style.cssText = "background:#e6f4ea;color:#1e7e34;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;display:block;"; }
    } else {
      kart.style.display = "none";
    }
  }
}

window.yoklamalarimKaydet = async function (dersId, sinif, dersNo, teacherId, dersAdi) {
  const checkboxlar = document.querySelectorAll(`[id^="ymchk_${sinif}_${dersNo}_"]`);
  const yoklar = [];
  checkboxlar.forEach((c) => { if (c.checked) yoklar.push(c.value); });
  const mesajEl = document.getElementById("ymMesaj_" + sinif + "_" + dersNo);
  if (mesajEl) mesajEl.innerHTML = '<span style="color:#1a73e8;">Kaydediliyor...</span>';

  const simdi = new Date();
  const simdiDk = simdi.getHours() * 60 + simdi.getMinutes();
  const saatStr = state.ymSaatler[dersNo];
  let isManual = false;
  if (saatStr) {
    const [s, d] = saatStr.split(":").map(Number);
    isManual = simdiDk > s * 60 + d + YOKLAMA_PENCERE_DK;
  }

  try {
    const eskiSnap = await getDocs(
      query(collection(db, "attendance"), where("date", "==", bugun), where("class_id", "==", sinif), where("lesson_number", "==", dersNo)),
    );
    await Promise.all(eskiSnap.docs.map((d) => deleteDoc(d.ref)));
    await addDoc(collection(db, "attendance"), {
      date: bugun, class_id: sinif, lesson_number: dersNo, lesson_name: dersAdi,
      teacher_id: teacherId, actual_teacher: state.ogretmenDoc?.id || teacherId,
      absent_students: yoklar, created_at: serverTimestamp(), entered_at: serverTimestamp(),
      is_late_entry: isManual, is_manual: isManual, locked: false,
    });
    if (dersId) { try { await updateDoc(doc(db, "today_lessons", dersId), { status: "filled" }); } catch {} }
    const kartId = "ym_" + sinif.replace(/[^a-zA-Z0-9]/g, "") + "_" + dersNo;
    const kart = document.getElementById(kartId);
    if (kart) kart.style.display = "none";
    if (mesajEl) mesajEl.innerHTML = `<span style="color:#34a853;">✓ Kaydedildi (${yoklar.length} devamsiz)</span>`;
  } catch (err) {
    if (mesajEl) mesajEl.innerHTML = `<span style="color:#ea4335;">Hata: ${esc(err.message)}</span>`;
  }
};

window.ymAkordiyon = function (kartId) {
  const panel = document.getElementById("panel_" + kartId);
  const ok = document.getElementById("ok_" + kartId);
  if (!panel) return;
  const acik = panel.style.display !== "none";
  panel.style.display = acik ? "none" : "block";
  if (ok) ok.style.transform = acik ? "rotate(180deg)" : "";
};
window.ymTumunuSec = function (sinif, dersNo) {
  document.querySelectorAll(`[id^="ymchk_${sinif}_${dersNo}_"]`).forEach((c) => { c.checked = !c.checked; });
};

// ── DYK ÖĞRETMEN ──
window.dykSayfasiYukle = async function () {
  const container = document.getElementById("dykListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  if (state.dykTimer) { clearInterval(state.dykTimer); state.dykTimer = null; }

  const gunAdilar = ["pazar","pazartesi","salı","çarşamba","perşembe","cuma","cumartesi"];
  const bugunAdi = gunAdilar[new Date().getDay()];

  const snap = await getDocs(collection(db, "dyk_courses"));
  state.dykKurslar = [];
  snap.forEach((d) => {
    const k = { id: d.id, ...d.data() };
    if ((!k.gun || k.gun === bugunAdi) && (!state.ogretmenDoc || k.teacher_id === state.ogretmenDoc.id))
      state.dykKurslar.push(k);
  });

  if (!state.dykKurslar.length) {
    container.innerHTML = '<div class="bos-mesaj">Bugun icin DYK kursu atanmamis.</div>';
    return;
  }

  const attSnap = await getDocs(
    query(collection(db, "dyk_attendance"), where("date", "==", bugun)),
  );
  const girilmisSet = new Set();
  attSnap.forEach((d) => girilmisSet.add(d.data().course_id));

  let html = "";
  for (const kurs of state.dykKurslar) {
    if (girilmisSet.has(kurs.id)) continue;
    const kartId = "dyk_" + kurs.id.replace(/[^a-zA-Z0-9]/g, "");
    const saatStr = kurs.saat || "";

    html += `<div class="ders-kart" id="${kartId}"><div style="width:100%;">
      <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px;" onclick="dykAkordiyon('${kartId}')">
        <div style="flex:1;min-width:0;">
          <div class="ders-bilgi-baslik">${esc(kurs.class_id)} — ${esc(kurs.course_name)}</div>
          <div class="ders-bilgi-alt" style="margin-top:4px;">DYK Kursu${saatStr ? " • " + saatStr : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <span id="dykBadge_${kartId}" style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"></span>
          <span id="dykOk_${kartId}" style="font-size:18px;color:var(--mavi);transition:transform 0.2s;">▼</span>
        </div>
      </div>
      <div id="dykPanel_${kartId}" style="display:none;margin-top:12px;">
        <div id="dykUyari_${kartId}" style="border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;"></div>`;

    let ogrenciler = [];
    if (kurs.enrolled_students?.length) {
      ogrenciler = kurs.enrolled_students.map((s) => ({ id: s.student_id, name: s.student_name, student_number: s.student_number, class_id: s.class_id }));
    } else {
      const ogrSnap = await getDocs(query(collection(db, "students"), where("class_id", "==", kurs.class_id)));
      ogrSnap.forEach((d) => ogrenciler.push({ id: d.id, ...d.data() }));
    }
    ogrenciler.sort((a, b) => (a.name || "").localeCompare(b.name || "", "tr"));
    const cokSinifli = ogrenciler.some((o) => o.class_id !== kurs.class_id);

    if (ogrenciler.length) {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;margin-bottom:10px;">';
      ogrenciler.forEach((ogr) => {
        const chkId = "dykchk_" + kurs.id + "_" + ogr.id;
        const sinifEtiketi = cokSinifli ? ` <small style="color:#888;font-size:11px;">(${esc(ogr.class_id)})</small>` : "";
        html += `<label class="ogrenci-label"><input type="checkbox" id="${chkId}" value="${esc(ogr.student_number || ogr.id)}" style="width:16px;height:16px;"><span>${esc(ogr.name || "")}${sinifEtiketi}</span></label>`;
      });
      html += "</div>";
    } else {
      html += '<div style="color:#888;font-size:13px;">Ogrenci bulunamadi.</div>';
    }

    const kursAdiEsc = (kurs.course_name || "").replace(/'/g, "\\'");
    html += `<div style="display:flex;gap:8px;">
        <button class="btn btn-yesil btn-sm" onclick="dykKaydet('${kurs.id}','${esc(kurs.class_id)}','${kursAdiEsc}')">💾 Kaydet</button>
        <button class="btn btn-gri btn-sm" onclick="dykTumunuSec('${kurs.id}')">Tumunu Sec</button>
      </div>
      <div id="dykMesaj_${kurs.id}" style="font-size:13px;margin-top:6px;"></div>
    </div></div></div>`;
  }

  if (!html) html = '<div class="ym-tamam">✓ Bugunun tum DYK yoklamalari girildi!</div>';
  container.innerHTML = html;
  _dykZamanGuncelle();
  state.dykTimer = setInterval(_dykZamanGuncelle, 30000);
};

function _dykZamanGuncelle() {
  const simdi = new Date();
  const simdiDk = simdi.getHours() * 60 + simdi.getMinutes();
  for (const kurs of state.dykKurslar) {
    const kartId = "dyk_" + kurs.id.replace(/[^a-zA-Z0-9]/g, "");
    const kart = document.getElementById(kartId);
    if (!kart || kart.style.display === "none") continue;
    const saatStr = kurs.saat;
    const badge = document.getElementById("dykBadge_" + kartId);
    const uyari = document.getElementById("dykUyari_" + kartId);
    const panel = document.getElementById("dykPanel_" + kartId);
    const ok = document.getElementById("dykOk_" + kartId);
    if (!saatStr) {
      if (badge) { badge.textContent = "Acik"; badge.style.cssText = "background:#e6f4ea;color:#1e7e34;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
      if (panel && panel.style.display === "none") { panel.style.display = "block"; if (ok) ok.style.transform = ""; }
      continue;
    }
    const [s, d] = saatStr.split(":").map(Number);
    const baslamaDk = s * 60 + d;
    const bitimDk = baslamaDk + YOKLAMA_PENCERE_DK;
    if (simdiDk < baslamaDk) {
      const fark = baslamaDk - simdiDk;
      kart.style.opacity = "0.7"; kart.style.pointerEvents = "none";
      if (panel) { panel.style.display = "none"; if (ok) ok.style.transform = "rotate(180deg)"; }
      if (badge) { badge.textContent = "⏰ " + fark + " dk sonra"; badge.style.cssText = "background:#f1f3f4;color:#5f6368;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
    } else if (simdiDk <= bitimDk) {
      const kalan = bitimDk - simdiDk;
      kart.style.opacity = "1"; kart.style.pointerEvents = ""; kart.style.borderLeft = "4px solid var(--yesil)";
      if (panel && panel.style.display === "none") { panel.style.display = "block"; if (ok) ok.style.transform = ""; }
      if (badge) { badge.textContent = "⏱ " + kalan + " dk kaldi"; badge.style.cssText = "background:#fff3e0;color:#e65100;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;"; }
      if (uyari) { uyari.textContent = "Gelmeyen ogrencileri isaretleyin. " + kalan + " dakika icinde kaydedin."; uyari.style.cssText = "background:#e6f4ea;color:#1e7e34;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:10px;display:block;"; }
    } else {
      kart.style.display = "none";
    }
  }
}

window.dykKaydet = async function (kursId, sinif, kursAdi) {
  const checkboxlar = document.querySelectorAll(`[id^="dykchk_${kursId}_"]`);
  const yoklar = [];
  checkboxlar.forEach((c) => { if (c.checked) yoklar.push(c.value); });
  const mesajEl = document.getElementById("dykMesaj_" + kursId);
  if (mesajEl) mesajEl.innerHTML = '<span style="color:#1a73e8;">Kaydediliyor...</span>';
  const simdi = new Date();
  const simdiDk = simdi.getHours() * 60 + simdi.getMinutes();
  const kurs = state.dykKurslar.find((k) => k.id === kursId);
  let isManual = false;
  if (kurs?.saat) { const [s, d] = kurs.saat.split(":").map(Number); isManual = simdiDk > s * 60 + d + YOKLAMA_PENCERE_DK; }
  try {
    const eskiSnap = await getDocs(
      query(collection(db, "dyk_attendance"), where("date", "==", bugun), where("course_id", "==", kursId)),
    );
    await Promise.all(eskiSnap.docs.map((d) => deleteDoc(d.ref)));
    await addDoc(collection(db, "dyk_attendance"), {
      date: bugun, course_id: kursId, class_id: sinif, course_name: kursAdi,
      teacher_id: state.ogretmenDoc?.id || "", absent_students: yoklar, is_manual: isManual, created_at: serverTimestamp(),
    });
    const kartId = "dyk_" + kursId.replace(/[^a-zA-Z0-9]/g, "");
    const kart = document.getElementById(kartId);
    if (kart) kart.style.display = "none";
    if (mesajEl) mesajEl.innerHTML = `<span style="color:#34a853;">✓ Kaydedildi (${yoklar.length} devamsiz)</span>`;
  } catch (err) {
    if (mesajEl) mesajEl.innerHTML = `<span style="color:#ea4335;">Hata: ${esc(err.message)}</span>`;
  }
};
window.dykAkordiyon = function (kartId) {
  const panel = document.getElementById("dykPanel_" + kartId);
  const ok = document.getElementById("dykOk_" + kartId);
  if (!panel) return;
  const acik = panel.style.display !== "none";
  panel.style.display = acik ? "none" : "block";
  if (ok) ok.style.transform = acik ? "rotate(180deg)" : "";
};
window.dykTumunuSec = function (kursId) {
  document.querySelectorAll(`[id^="dykchk_${kursId}_"]`).forEach((c) => { c.checked = !c.checked; });
};

// ── DYK KURS YÖNETİM (Ayarlar'dan çağrılır) ──
const _dykPanelAcik = new Set();

window.dykAyarlarYukle = async function () {
  const sel = document.getElementById("dykKursOgretmen");
  if (sel) {
    sel.innerHTML = '<option value="">Ogretmen secin</option>';
    state.ogretmenler.forEach((o) => { sel.innerHTML += `<option value="${o.id}">${esc(o.ad)}</option>`; });
  }
  await _dykKursListesiYukle();
};

async function _dykKursListesiYukle() {
  const container = document.getElementById("dykKursListesi");
  if (!container) return;
  _dykPanelAcik.clear();
  const snap = await getDocs(collection(db, "dyk_courses"));
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Henuz kurs eklenmemis</div>'; return; }
  const gunAdlar = { pazartesi: "Pazartesi", "salı": "Salı", "çarşamba": "Çarşamba", "perşembe": "Perşembe", cuma: "Cuma" };
  let html = "<table><thead><tr><th>Kurs</th><th>Sinif</th><th>Ogretmen</th><th>Gun</th><th>Saat</th><th></th></tr></thead><tbody>";
  snap.forEach((d) => {
    const k = { id: d.id, ...d.data() };
    const ogr = state.ogretmenler.find((o) => o.id === k.teacher_id);
    const kayitliSayisi = k.enrolled_students?.length || 0;
    html += `<tr>
      <td>${esc(k.course_name)}</td><td>${esc(k.class_id)}</td><td>${esc(ogr?.ad || "-")}</td>
      <td>${esc(gunAdlar[k.gun] || "-")}</td><td>${esc(k.saat || "-")}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-gri btn-sm" onclick="dykOgrenciPaneliToggle('${k.id}')">Öğrenciler (${kayitliSayisi})</button>
        <button class="btn btn-kirmizi btn-sm" onclick="dykKursSil('${k.id}')">Sil</button>
      </td>
    </tr>
    <tr id="ogr-panel-${k.id}" style="display:none;">
      <td colspan="6" style="padding:0;"><div id="ogr-panel-icerik-${k.id}" style="padding:14px;background:#f8f9fa;border-top:1px solid var(--border);"><div class="yukleniyor">Yükleniyor...</div></div></td>
    </tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

window.dykOgrenciPaneliToggle = async function (kursId) {
  const row = document.getElementById("ogr-panel-" + kursId);
  if (!row) return;
  const acik = row.style.display !== "none";
  row.style.display = acik ? "none" : "";
  if (!acik && !_dykPanelAcik.has(kursId)) { _dykPanelAcik.add(kursId); await window.dykOgrenciPaneliYukle(kursId); }
};
window.dykOgrenciPaneliYukle = async function (kursId) {
  const icerik = document.getElementById("ogr-panel-icerik-" + kursId);
  if (!icerik) return;
  const kursDoc = await getDoc(doc(db, "dyk_courses", kursId));
  const enrolled = kursDoc.exists() ? (kursDoc.data().enrolled_students || []) : [];
  const sinifOptions = state.siniflar.map((s) => `<option value="${s.class_name}">${s.class_name}</option>`).join("");
  const enrolledHtml = enrolled.length
    ? enrolled.map((s) => `<span class="dyk-kayitli-tag">${esc(s.student_name)} <span style="color:#888;font-size:11px;">(${esc(s.class_id)})</span><button onclick="dykOgrenciKaldir('${kursId}','${s.student_id}')" style="background:none;border:none;cursor:pointer;color:#666;font-size:14px;line-height:1;padding:0 2px;">×</button></span>`).join("")
    : '<span style="color:#999;font-size:13px;">Henüz öğrenci eklenmemiş.</span>';
  icerik.innerHTML = `
    <div style="margin-bottom:10px;">
      <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px;">Kayıtlı Öğrenciler (${enrolled.length})</div>
      <div id="enrolled-list-${kursId}">${enrolledHtml}</div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:10px;">
      <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px;">Sınıftan Öğrenci Ekle</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <select id="dyk-sinif-sec-${kursId}" onchange="dykPanelSinifYukle('${kursId}')" style="font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;">
          <option value="">Sınıf seçin...</option>${sinifOptions}
        </select>
      </div>
      <div id="dyk-sinif-ogr-${kursId}" style="margin-bottom:8px;"></div>
      <button class="btn btn-yesil btn-sm" onclick="dykOgrenciEkle('${kursId}')">+ Seçilenleri Ekle</button>
    </div>`;
};
window.dykPanelSinifYukle = async function (kursId) {
  const sinif = document.getElementById("dyk-sinif-sec-" + kursId)?.value;
  const container = document.getElementById("dyk-sinif-ogr-" + kursId);
  if (!container || !sinif) return;
  container.innerHTML = '<span style="color:#999;font-size:13px;">Yükleniyor...</span>';
  const kursDoc = await getDoc(doc(db, "dyk_courses", kursId));
  const enrolled = kursDoc.exists() ? (kursDoc.data().enrolled_students || []) : [];
  const enrolledIds = new Set(enrolled.map((s) => s.student_id));
  const snap = await getDocs(query(collection(db, "students"), where("class_id", "==", sinif)));
  let ogrenciler = [];
  snap.forEach((d) => ogrenciler.push({ id: d.id, ...d.data() }));
  ogrenciler.sort((a, b) => (a.name || "").localeCompare(b.name || "", "tr"));
  if (!ogrenciler.length) { container.innerHTML = '<span style="color:#999;font-size:13px;">Bu sınıfta öğrenci yok.</span>'; return; }
  container.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px;">` +
    ogrenciler.map((o) => {
      const checked = enrolledIds.has(o.id) ? "checked disabled" : "";
      const style = enrolledIds.has(o.id) ? "opacity:0.5;" : "";
      return `<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#fff;border-radius:6px;cursor:pointer;font-size:13px;${style}"><input type="checkbox" ${checked} data-id="${o.id}" data-name="${(o.name || "").replace(/"/g, "&quot;")}" data-no="${o.student_number || ""}" data-sinif="${sinif}" style="width:14px;height:14px;"><span>${esc(o.name || "")}</span></label>`;
    }).join("") + `</div>`;
};
window.dykOgrenciEkle = async function (kursId) {
  const container = document.getElementById("dyk-sinif-ogr-" + kursId);
  if (!container) return;
  const checkboxlar = container.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)');
  if (!checkboxlar.length) return;
  const kursDoc = await getDoc(doc(db, "dyk_courses", kursId));
  const enrolled = kursDoc.exists() ? [...(kursDoc.data().enrolled_students || [])] : [];
  const enrolledIds = new Set(enrolled.map((s) => s.student_id));
  checkboxlar.forEach((c) => {
    if (!enrolledIds.has(c.dataset.id)) enrolled.push({ student_id: c.dataset.id, student_name: c.dataset.name, student_number: c.dataset.no, class_id: c.dataset.sinif });
  });
  await updateDoc(doc(db, "dyk_courses", kursId), { enrolled_students: enrolled });
  _dykPanelAcik.delete(kursId);
  const btn = document.querySelector(`[onclick="dykOgrenciPaneliToggle('${kursId}')"]`);
  if (btn) btn.textContent = "Öğrenciler (" + enrolled.length + ")";
  await window.dykOgrenciPaneliYukle(kursId);
};
window.dykOgrenciKaldir = async function (kursId, studentId) {
  const kursDoc = await getDoc(doc(db, "dyk_courses", kursId));
  if (!kursDoc.exists()) return;
  const enrolled = (kursDoc.data().enrolled_students || []).filter((s) => s.student_id !== studentId);
  await updateDoc(doc(db, "dyk_courses", kursId), { enrolled_students: enrolled });
  _dykPanelAcik.delete(kursId);
  const btn = document.querySelector(`[onclick="dykOgrenciPaneliToggle('${kursId}')"]`);
  if (btn) btn.textContent = "Öğrenciler (" + enrolled.length + ")";
  await window.dykOgrenciPaneliYukle(kursId);
};
window.dykKursEkle = async function () {
  const ad = document.getElementById("dykKursAdi").value.trim();
  const sinif = document.getElementById("dykKursSinif").value.trim().toUpperCase();
  const ogretmen = document.getElementById("dykKursOgretmen").value;
  const gun = document.getElementById("dykKursGun").value;
  const saat = document.getElementById("dykKursSaat").value;
  if (!ad || !sinif || !ogretmen) { mesajGoster("dykKursEkleMesaj", "Kurs adi, sinif ve ogretmen zorunlu.", "hata"); return; }
  await addDoc(collection(db, "dyk_courses"), { course_name: ad, class_id: sinif, teacher_id: ogretmen, gun, saat, created_at: serverTimestamp() });
  mesajGoster("dykKursEkleMesaj", "Kurs eklendi.", "basari");
  ["dykKursAdi", "dykKursSinif", "dykKursSaat"].forEach((id) => { document.getElementById(id).value = ""; });
  await _dykKursListesiYukle();
};
window.dykKursSil = async function (id) {
  const { sor: sorFn } = await import("./portal-utils.js");
  if (!await sorFn("Kursu Sil", "Bu kursu silmek istiyor musunuz?", "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "dyk_courses", id));
  await _dykKursListesiYukle();
};

// ── MANUEL YOKLAMA ──
let _dersListesiCache = null;

window.manuelOgrencileriGetir = async () => {
  const sinif = document.getElementById("manuelSinif").value;
  if (!sinif) return;

  manuelDersAdiGuncelle();

  const snap = await getDocs(
    query(collection(db, "students"), where("class_id", "==", sinif), where("status", "==", "active")),
  );
  let ogrenciler = [];
  snap.forEach((d) => ogrenciler.push(d.data()));
  ogrenciler.sort((a, b) => a.student_number.localeCompare(b.student_number));
  let html = "";
  ogrenciler.forEach((o) => {
    html += `<div class="ogrenci-satir" id="man-satir-${o.student_number}" onclick="manuelIsaretle('${o.student_number}')"><input type="checkbox" id="man-chk-${o.student_number}" onclick="event.stopPropagation(); manuelIsaretle('${o.student_number}')"><span class="ogrenci-no">${esc(o.student_number)}</span><span class="ogrenci-isim">${esc(o.name)}</span></div>`;
  });
  document.getElementById("manuelOgrenciListesi").innerHTML = html || '<div class="bos-mesaj">Ogrenci yok.</div>';
  document.getElementById("manuelOgrenciKarti").style.display = "block";
};
window.manuelDersAdiGuncelle = async () => {
  const select = document.getElementById("manuelDersAdi");
  if (!select) return;

  if (!_dersListesiCache) {
    const snap = await getDocs(collection(db, "ders_listesi"));
    _dersListesiCache = [];
    snap.forEach(d => { if (d.data().ders_adi) _dersListesiCache.push(d.data().ders_adi); });
    _dersListesiCache.sort((a, b) => a.localeCompare(b, "tr"));
  }

  if (!_dersListesiCache.length) {
    select.innerHTML = '<option value="">Ders listesi boş</option>';
  } else {
    select.innerHTML = '<option value="">Ders seçin...</option>' +
      _dersListesiCache.map(n => `<option value="${n}">${n}</option>`).join('');
  }
};

window.manuelIsaretle = (no) => {
  const chk = document.getElementById("man-chk-" + no);
  chk.checked = !chk.checked;
  document.getElementById("man-satir-" + no).classList.toggle("yok", chk.checked);
};
window.manuelKaydet = async () => {
  const sinif = document.getElementById("manuelSinif").value;
  const dersAdi = document.getElementById("manuelDersAdi").value.trim();
  if (!sinif || !dersAdi) { mesajGoster("manuelMesaj", "Tum alanlari doldurun.", "hata"); return; }
  const yoklar = [];
  document.querySelectorAll("#manuelOgrenciListesi input:checked").forEach((c) => yoklar.push(c.id.replace("man-chk-", "")));
  try {
    await addDoc(collection(db, "attendance"), {
      date: document.getElementById("manuelTarih").value,
      class_id: sinif,
      lesson_number: parseInt(document.getElementById("manuelDersNo").value),
      lesson_name: dersAdi,
      teacher_id: state.ogretmenDoc?.id || "manuel",
      actual_teacher: state.ogretmenDoc?.id || "manuel",
      absent_students: yoklar,
      created_at: serverTimestamp(),
      entered_at: serverTimestamp(),
      is_late_entry: true,
      is_manual: true,
      locked: true,
    });
    mesajGoster("manuelMesaj", "Manuel yoklama kaydedildi.", "basari");
  } catch (err) {
    mesajGoster("manuelMesaj", "Hata: " + err.message, "hata");
  }
};

// ── ÖĞRETMENİN GÖREVLERİ ──
export async function ogretmenGorevleriniYukle() {
  const container = document.getElementById("ogretmenGorevListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  if (!state.ogretmenDoc) {
    container.innerHTML = '<div class="bos-mesaj">Ogretmen bilgisi bulunamadi.</div>';
    return;
  }
  const snap = await getDocs(
    query(collection(db, "gorevler"), where("atanan_ids", "array-contains", state.ogretmenDoc.id)),
  );
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Henuz gorev atanmamis.</div>'; return; }
  const gorevler = [];
  snap.forEach((d) => gorevler.push({ id: d.id, ...d.data() }));
  gorevler.sort((a, b) => (b.olusturulma_tarihi || "").localeCompare(a.olusturulma_tarihi || ""));
  const durumRozet = { acik: "rozet-mavi", tamamlandi: "rozet-yesil", tamamlanmadi: "rozet-kirmizi", iptal: "rozet-gri" };
  const durumEtiket = { acik: "Acik", tamamlandi: "Tamamlandi", tamamlanmadi: "Tamamlanmadi", iptal: "Iptal" };
  let html = "";
  gorevler.forEach((g) => {
    const gecti = g.son_tarih && g.son_tarih < bugun && g.durum === "acik";
    html += `<div class="gorev-kart ${g.durum || "acik"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div class="gorev-baslik">${esc(g.baslik)}</div>
        <span class="rozet ${durumRozet[g.durum] || "rozet-mavi"}">${durumEtiket[g.durum] || "Acik"}</span>
      </div>
      <div class="gorev-meta">
        <span>📅 Son Tarih: <strong ${gecti ? 'style="color:var(--kirmizi)"' : ""}>${esc(g.son_tarih || "—")}${gecti ? " ⚠️" : ""}</strong></span>
        <span>${g.tur === "brans" ? "🎓 Brans: " + esc(g.brans) : "📌 Genel"}</span>
      </div>
      ${g.aciklama ? `<p style="font-size:13px;color:var(--text2);">${esc(g.aciklama)}</p>` : ""}
    </div>`;
  });
  container.innerHTML = html;
}
window.ogretmenGorevleriniYukle = ogretmenGorevleriniYukle;
