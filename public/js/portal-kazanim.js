import {
  db, bugun,
  getDocs, addDoc, updateDoc, deleteDoc, getDoc,
  collection, query, where, orderBy, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, haftaNoHesapla, haftaNoBasit, sor } from "./portal-utils.js";

// ── KAZANIM SAYFASI (Admin) ──
export function kazanimSayfasiYukle() {
  _kazanimBranslariYukle();
  _kazanimDersleriniYukle();
  _kazanimDersDoldur();
  _kazanimTakvimYukle();
}
window.kazanimSayfasiYukle = kazanimSayfasiYukle;

window.kazanimSekme = function (id, el) {
  document.querySelectorAll("#sayfa-kazanimlar .sekme-icerik").forEach((s) => s.classList.remove("aktif"));
  document.querySelectorAll("#sayfa-kazanimlar .sekme-btn").forEach((b) => b.classList.remove("aktif"));
  document.getElementById("ksekme-" + id).classList.add("aktif");
  el.classList.add("aktif");
  if (id === "dersler") _kazanimDersleriniYukle();
  else if (id === "kazanimlar") _kazanimDersDoldur();
  else if (id === "takvim") _kazanimTakvimYukle();
  else if (id === "tatil") _kazanimTatilleriniYukle();
};

async function _kazanimBranslariYukle() {
  const sel = document.getElementById("kazDersAdi");
  const snap = await getDocs(collection(db, "teachers"));
  const branslar = new Set();
  snap.forEach((d) => { if (d.data().brans) branslar.add(d.data().brans.trim()); });
  const sirali = [...branslar].sort((a, b) => a.localeCompare(b, "tr"));
  sel.innerHTML = '<option value="">Brans secin...</option>' +
    sirali.map((b) => `<option value="${b}">${esc(b)}</option>`).join("");
}

async function _kazanimDersleriniYukle() {
  const container = document.getElementById("kazDersListesi");
  const snap = await getDocs(query(collection(db, "kazanim_dersler"), orderBy("sinif_seviyesi")));
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Henuz ders tanimlanmamis.</div>'; return; }
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));

  // Paralel kazanım sayıları
  const kSnapArr = await Promise.all(
    rows.map((r) => getDocs(query(collection(db, "kazanim_listesi"), where("ders_id", "==", r.id)))),
  );
  let html = "<table><thead><tr><th>Ders Adi</th><th>Sinif Seviyesi</th><th>Kazanim Sayisi</th><th></th></tr></thead><tbody>";
  rows.forEach((r, i) => {
    html += `<tr><td><strong>${esc(r.ders_adi)}</strong></td><td>${r.sinif_seviyesi}. Sinif</td><td><span class="rozet rozet-mavi">${kSnapArr[i].size} kazanim</span></td><td><button class="btn btn-kirmizi btn-sm" onclick="kazanimDersSil('${r.id}','${esc(r.ders_adi)}')">Sil</button></td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

window.kazanimDersEkle = async () => {
  const ad = document.getElementById("kazDersAdi").value;
  const seviye = document.getElementById("kazDersSeviye").value;
  if (!ad) { mesajGoster("kazDersMesaj", "Brans secin.", "hata"); return; }
  const kontrol = await getDocs(
    query(collection(db, "kazanim_dersler"), where("ders_adi", "==", ad), where("sinif_seviyesi", "==", parseInt(seviye))),
  );
  if (!kontrol.empty) { mesajGoster("kazDersMesaj", "Bu ders zaten tanimli.", "hata"); return; }
  await addDoc(collection(db, "kazanim_dersler"), { ders_adi: ad, sinif_seviyesi: parseInt(seviye), olusturulma: serverTimestamp() });
  mesajGoster("kazDersMesaj", "Ders eklendi.", "basari");
  document.getElementById("kazDersAdi").value = "";
  _kazanimDersleriniYukle();
  _kazanimDersDoldur();
};

window.kazanimDersSil = async (id, ad) => {
  if (!await sor("Dersi Sil", `"${ad}" dersini ve tum kazanimlarini silmek istiyor musunuz?`, "Sil", "btn-kirmizi")) return;
  const kSnap = await getDocs(query(collection(db, "kazanim_listesi"), where("ders_id", "==", id)));
  await Promise.all(kSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "kazanim_dersler", id));
  _kazanimDersleriniYukle();
  _kazanimDersDoldur();
};

async function _kazanimDersDoldur() {
  const select = document.getElementById("kazDersSecim");
  if (!select) return;
  const snap = await getDocs(query(collection(db, "kazanim_dersler"), orderBy("sinif_seviyesi")));
  select.innerHTML = '<option value="">Ders secin...</option>';
  snap.forEach((d) => {
    const data = d.data();
    select.innerHTML += `<option value="${d.id}">${data.sinif_seviyesi}. Sinif - ${esc(data.ders_adi)}</option>`;
  });
}

window.kazanimListesiYukle = async () => {
  state.aktifKazanimDersId = document.getElementById("kazDersSecim").value;
  if (!state.aktifKazanimDersId) { document.getElementById("kazanimListeKarti").style.display = "none"; return; }
  document.getElementById("kazanimListeKarti").style.display = "block";
  const dersDoc = await getDoc(doc(db, "kazanim_dersler", state.aktifKazanimDersId));
  const dersAdi = dersDoc.exists() ? dersDoc.data().sinif_seviyesi + ". Sinif - " + dersDoc.data().ders_adi : "";
  document.getElementById("kazListeBaslik").textContent = dersAdi + " Kazanimlari";
  const snap = await getDocs(
    query(collection(db, "kazanim_listesi"), where("ders_id", "==", state.aktifKazanimDersId), orderBy("hafta_no")),
  );
  const container = document.getElementById("kazAnimListesi");
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Bu ders icin kazanim girilmemis. Excel ile yukleyin.</div>'; return; }
  let html = "<table><thead><tr><th>Hafta</th><th>Kazanim</th></tr></thead><tbody>";
  snap.forEach((d) => {
    const data = d.data();
    html += `<tr><td style="white-space:nowrap;font-weight:700;">${data.hafta_no}. Hafta</td><td>${esc(data.kazanim)}</td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
};

window.kazanimExcelOku = (input) => {
  if (!window.XLSX) { mesajGoster("kazExcelMesaj", "Excel okuyucu yukleniyor, 3 saniye bekleyip tekrar deneyin.", "bilgi"); return; }
  const dosya = input.files[0];
  if (!dosya) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const wb = XLSX.read(data, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    state.kazanimExcelVerisi = rows.slice(1).filter((r) => r[0] && r[1])
      .map((r) => ({ hafta_no: parseInt(r[0]), kazanim: String(r[1]).trim() }))
      .filter((r) => r.hafta_no && r.kazanim);
    const max5 = state.kazanimExcelVerisi.slice(0, 5);
    let onizleme = `<div style="padding:8px 12px;background:var(--bg);font-size:12px;color:var(--text2);border-bottom:1px solid var(--border);">${state.kazanimExcelVerisi.length} kazanim bulundu</div><table><thead><tr><th>Hafta</th><th>Kazanim</th></tr></thead><tbody>`;
    max5.forEach((r) => { onizleme += `<tr><td>${r.hafta_no}</td><td>${esc(r.kazanim)}</td></tr>`; });
    onizleme += "</tbody></table>";
    document.getElementById("kazExcelOnizleme").innerHTML = onizleme;
    document.getElementById("kazExcelOnizleme").style.display = "block";
    document.getElementById("kazExcelImportBtn").disabled = state.kazanimExcelVerisi.length === 0;
  };
  reader.readAsArrayBuffer(dosya);
};

window.kazanimExcelImport = async () => {
  if (!state.aktifKazanimDersId || !state.kazanimExcelVerisi.length) return;
  mesajGoster("kazExcelMesaj", "Yukleniyor...", "bilgi");
  const eskiSnap = await getDocs(
    query(collection(db, "kazanim_listesi"), where("ders_id", "==", state.aktifKazanimDersId)),
  );
  await Promise.all(eskiSnap.docs.map((d) => deleteDoc(d.ref)));
  for (let i = 0; i < state.kazanimExcelVerisi.length; i += 50) {
    const grup = state.kazanimExcelVerisi.slice(i, i + 50);
    await Promise.all(
      grup.map((k) => addDoc(collection(db, "kazanim_listesi"), { ders_id: state.aktifKazanimDersId, hafta_no: k.hafta_no, kazanim: k.kazanim, olusturulma: serverTimestamp() })),
    );
  }
  mesajGoster("kazExcelMesaj", state.kazanimExcelVerisi.length + " kazanim yuklendi.", "basari");
  state.kazanimExcelVerisi = [];
  document.getElementById("kazExcelImportBtn").disabled = true;
  document.getElementById("kazExcelDosya").value = "";
  document.getElementById("kazExcelOnizleme").style.display = "none";
  window.kazanimListesiYukle();
};

async function _kazanimTakvimYukle() {
  const snap = await getDocs(collection(db, "kazanim_takvim"));
  if (snap.empty) { document.getElementById("kazTakvimBilgiKarti")?.style && (document.getElementById("kazTakvimBilgiKarti").style.display = "none"); return; }
  const veri = snap.docs[0].data();
  document.getElementById("kazTakvimYil")?.value !== undefined && (document.getElementById("kazTakvimYil").value = veri.egitim_yili || "");
  document.getElementById("kazTakvimBaslangic")?.value !== undefined && (document.getElementById("kazTakvimBaslangic").value = veri.baslangic_tarihi || "");
  const bilgiKarti = document.getElementById("kazTakvimBilgiKarti");
  if (bilgiKarti) {
    bilgiKarti.style.display = "block";
    document.getElementById("kazTakvimBilgi").innerHTML =
      `<table><tbody>
        <tr><td style="color:var(--text2);padding:8px 0;">Egitim Yili</td><td><strong>${esc(veri.egitim_yili || "-")}</strong></td></tr>
        <tr><td style="color:var(--text2);padding:8px 0;">1. Hafta Baslangici</td><td><strong>${esc(veri.baslangic_tarihi || "-")}</strong></td></tr>
        <tr><td style="color:var(--text2);padding:8px 0;">Bugun (tahmini)</td><td><strong style="color:var(--mavi);">${haftaNoBasit(veri.baslangic_tarihi, bugun)}. Hafta</strong></td></tr>
      </tbody></table>`;
  }
}

window.kazanimTakvimKaydet = async () => {
  const yil = document.getElementById("kazTakvimYil").value.trim();
  const baslangic = document.getElementById("kazTakvimBaslangic").value;
  if (!yil || !baslangic) { mesajGoster("kazTakvimMesaj", "Tum alanlari doldurun.", "hata"); return; }
  const snap = await getDocs(collection(db, "kazanim_takvim"));
  if (!snap.empty) {
    await updateDoc(snap.docs[0].ref, { egitim_yili: yil, baslangic_tarihi: baslangic, guncelleme: serverTimestamp() });
  } else {
    await addDoc(collection(db, "kazanim_takvim"), { egitim_yili: yil, baslangic_tarihi: baslangic, olusturulma: serverTimestamp() });
  }
  mesajGoster("kazTakvimMesaj", "Takvim kaydedildi.", "basari");
  _kazanimTakvimYukle();
};

async function _kazanimTatilleriniYukle() {
  const snap = await getDocs(query(collection(db, "kazanim_tatil"), orderBy("baslangic")));
  const container = document.getElementById("kazTatilListesi");
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Tatil girilmemis.</div>'; return; }
  let html = "<table><thead><tr><th>Tatil Adi</th><th>Baslangic</th><th>Bitis</th><th>Hafta</th><th></th></tr></thead><tbody>";
  snap.forEach((d) => {
    const data = d.data();
    html += `<tr><td><strong>${esc(data.ad)}</strong></td><td>${esc(data.baslangic)}</td><td>${esc(data.bitis)}</td><td>${data.hafta_sayisi} hafta</td><td><button class="btn btn-kirmizi btn-sm" onclick="kazanimTatilSil('${d.id}')">Sil</button></td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

window.kazanimTatilEkle = async () => {
  const ad = document.getElementById("kazTatilAdi").value.trim();
  const bas = document.getElementById("kazTatilBaslangic").value;
  const bit = document.getElementById("kazTatilBitis").value;
  if (!ad || !bas || !bit) { mesajGoster("kazTatilMesaj", "Tum alanlari doldurun.", "hata"); return; }
  const basDt = new Date(bas + "T12:00:00");
  const bitDt = new Date(bit + "T12:00:00");
  const fark = Math.max(1, Math.ceil((bitDt - basDt) / (7 * 86400000)) + 1);
  await addDoc(collection(db, "kazanim_tatil"), { ad, baslangic: bas, bitis: bit, hafta_sayisi: fark, olusturulma: serverTimestamp() });
  mesajGoster("kazTatilMesaj", fark + " haftalik tatil eklendi.", "basari");
  document.getElementById("kazTatilAdi").value = "";
  _kazanimTatilleriniYukle();
};

window.kazanimTatilSil = async (id) => {
  if (!await sor("Tatili Sil", "Bu tatili silmek istiyor musunuz?", "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "kazanim_tatil", id));
  _kazanimTatilleriniYukle();
};

// ── KAZANIMLARİM (Öğretmen) ──
export async function kazanimlarimYukle() {
  const otomatikContainer = document.getElementById("kazAnimOtomatik");
  const haftaBilgi = document.getElementById("kazAnimHaftaBilgi");
  otomatikContainer.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const [takvimSnap, tatilSnap] = await Promise.all([
    getDocs(collection(db, "kazanim_takvim")),
    getDocs(collection(db, "kazanim_tatil")),
  ]);
  if (takvimSnap.empty) { otomatikContainer.innerHTML = '<div class="bos-mesaj">Takvim henuz tanimlanmamis.</div>'; return; }
  const takvim = takvimSnap.docs[0].data();
  const tatiller = [];
  tatilSnap.forEach((d) => tatiller.push(d.data()));
  const haftaNo = haftaNoHesapla(takvim.baslangic_tarihi, bugun, tatiller);
  haftaBilgi.textContent = (takvim.egitim_yili || "") + " egitim yili - Bugun " + haftaNo + ". Hafta";
  haftaBilgi.style.display = "block";

  if (!state.ogretmenDoc) { otomatikContainer.innerHTML = '<div class="bos-mesaj">Ogretmen bilgisi bulunamadi.</div>'; return; }

  const progSnap = await getDocs(
    query(collection(db, "schedule"), where("teacher_id", "==", state.ogretmenDoc.id)),
  );
  if (progSnap.empty) { otomatikContainer.innerHTML = '<div class="bos-mesaj">Ders programinizda ders bulunamadi.</div>'; return; }

  const dersler = new Map();
  progSnap.forEach((d) => {
    const veri = d.data();
    const seviye = parseInt(veri.class_id?.charAt(0));
    if (!seviye || !veri.lesson_name) return;
    const key = seviye + "|" + veri.lesson_name;
    if (!dersler.has(key)) dersler.set(key, { sinif_seviyesi: seviye, ders_adi: veri.lesson_name, siniflar: new Set() });
    dersler.get(key).siniflar.add(veri.class_id);
  });

  // Paralel sorgular
  const dersEntries = [...dersler.entries()];
  const dersSnapArr = await Promise.all(
    dersEntries.map(([, ders]) =>
      getDocs(query(collection(db, "kazanim_dersler"), where("ders_adi", "==", ders.ders_adi), where("sinif_seviyesi", "==", ders.sinif_seviyesi))),
    ),
  );
  const kazSnapArr = await Promise.all(
    dersEntries.map((_, i) => {
      const dersSnap = dersSnapArr[i];
      if (dersSnap.empty) return null;
      return getDocs(query(collection(db, "kazanim_listesi"), where("ders_id", "==", dersSnap.docs[0].id), where("hafta_no", "==", haftaNo)));
    }),
  );

  let html = "";
  dersEntries.forEach(([, ders], i) => {
    const kazanim = kazSnapArr[i] && !kazSnapArr[i].empty ? kazSnapArr[i].docs[0].data().kazanim : null;
    const siniflar = [...ders.siniflar].sort().join(", ");
    html += `<div style="border:2px solid ${kazanim ? "var(--yesil)" : "var(--border)"};border-radius:12px;padding:16px;margin-bottom:12px;background:${kazanim ? "#f6fef8" : "white"};">
      <div style="font-size:13px;color:var(--text2);margin-bottom:4px;">${ders.sinif_seviyesi}. Sinif - ${esc(siniflar)}</div>
      <div style="font-size:17px;font-weight:700;margin-bottom:8px;">${esc(ders.ders_adi)}</div>
      ${kazanim
        ? `<div class="kazanim-metin" id="kaz-metin-${i}">${esc(kazanim)}</div>
           <button class="btn btn-gri btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('kaz-metin-${i}').textContent)">Kopyala</button>`
        : `<div style="color:var(--text2);font-size:13px;">${haftaNo}. hafta icin kazanim girilmemis.</div>`}
    </div>`;
  });

  otomatikContainer.innerHTML = html || '<div class="bos-mesaj">Ders programinizla eslesen kazanim bulunamadi.</div>';
}
window.kazanimlarimYukle = kazanimlarimYukle;

window.kazManuelSeviyeDegisti = async () => {
  const seviye = document.getElementById("kazManuelSeviye").value;
  const dersEl = document.getElementById("kazManuelDers");
  if (!seviye) { dersEl.innerHTML = '<option value="">Once seviye secin...</option>'; return; }
  dersEl.innerHTML = '<option value="">Yukleniyor...</option>';
  const snap = await getDocs(
    query(collection(db, "kazanim_dersler"), where("sinif_seviyesi", "==", parseInt(seviye))),
  );
  dersEl.innerHTML = '<option value="">Ders secin...</option>';
  snap.forEach((d) => { const data = d.data(); dersEl.innerHTML += `<option value="${d.id}">${esc(data.ders_adi)}</option>`; });
};

window.kazanimManuelSorgula = async () => {
  const dersId = document.getElementById("kazManuelDers").value;
  const container = document.getElementById("kazManuelSonuc");
  if (!dersId) { container.innerHTML = '<div class="bos-mesaj">Ders secin.</div>'; return; }
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const [takvimSnap, tatilSnap] = await Promise.all([
    getDocs(collection(db, "kazanim_takvim")),
    getDocs(collection(db, "kazanim_tatil")),
  ]);
  if (takvimSnap.empty) { container.innerHTML = '<div class="bos-mesaj">Takvim tanimlanmamis.</div>'; return; }
  const takvim = takvimSnap.docs[0].data();
  const tatiller = [];
  tatilSnap.forEach((d) => tatiller.push(d.data()));
  const haftaNo = haftaNoHesapla(takvim.baslangic_tarihi, bugun, tatiller);

  const [kazSnap, dersDoc] = await Promise.all([
    getDocs(query(collection(db, "kazanim_listesi"), where("ders_id", "==", dersId), where("hafta_no", "==", haftaNo))),
    getDoc(doc(db, "kazanim_dersler", dersId)),
  ]);
  const dersAdi = dersDoc.exists() ? dersDoc.data().sinif_seviyesi + ". Sinif - " + dersDoc.data().ders_adi : "";

  if (kazSnap.empty) {
    container.innerHTML = `<div class="kart"><div class="kart-baslik">${esc(dersAdi)}</div><div class="bos-mesaj">${haftaNo}. hafta icin kazanim girilmemis.</div></div>`;
    return;
  }
  const kazanim = kazSnap.docs[0].data().kazanim;
  container.innerHTML = `<div class="kart"><div class="kart-baslik">${esc(dersAdi)} - ${haftaNo}. Hafta</div>
    <div class="kazanim-metin" id="kazManuelSonucMetin" style="font-size:15px;padding:14px;background:var(--bg);border-radius:10px;margin-bottom:12px;">${esc(kazanim)}</div>
    <button class="btn btn-gri btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('kazManuelSonucMetin').textContent)">Kopyala</button>
  </div>`;
};
