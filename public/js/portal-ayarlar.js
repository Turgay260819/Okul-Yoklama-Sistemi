// ── AYARLAR MODÜLÜ ──
// portal.html'den ayrilmis bagimsiz JS dosyasi.
// window.__portal nesnesine ihtiyac duyar.

window.dersSaatleriKaydet = async function () {
  const { db, setDoc, doc, serverTimestamp } = window.__portal;
  const saatler = {};
  for (let i = 1; i <= 8; i++) {
    const val = document.getElementById("dersSaat" + i)?.value;
    if (val) saatler[i] = val;
  }
  await setDoc(doc(db, "ders_saatleri", "varsayilan"), {
    saatler,
    guncelleme: serverTimestamp(),
  });
  mesajGoster("dersSaatMesaj", "Ders saatleri kaydedildi.", "basari");
};

async function dersSaatleriYukle() {
  const { db, getDoc, doc } = window.__portal;
  const d = await getDoc(doc(db, "ders_saatleri", "varsayilan"));
  if (!d.exists()) return;
  const saatler = d.data().saatler || {};
  for (let i = 1; i <= 8; i++) {
    const el = document.getElementById("dersSaat" + i);
    if (el && saatler[i]) el.value = saatler[i];
  }
}

window.ayarSekme = function (id, el) {
  document
    .querySelectorAll("#sayfa-ayarlar .sekme-icerik")
    .forEach((s) => s.classList.remove("aktif"));
  document
    .querySelectorAll("#sayfa-ayarlar .sekme-btn")
    .forEach((b) => b.classList.remove("aktif"));
  document.getElementById("asekme-" + id).classList.add("aktif");
  el.classList.add("aktif");
  if (id === "dyk" && window.dykAyarlarYukle) window.dykAyarlarYukle();
};

window.ayarlarYukle = async function () {
  await ogretmenleriListele();
  await siniflariListele();
  await sinifDropdownlariniDoldur();
  await window.ogrencileriGetir();
  await donemBilgisiniGetir();
  dersSaatleriYukle();
  if (window.dykAyarlarYukle) window.dykAyarlarYukle();
};

async function ogretmenleriListele() {
  const { db, getDocs, collection, getTumOgretmenler } = window.__portal;
  const tumOgretmenler = getTumOgretmenler();
  const snap = await getDocs(collection(db, "teachers"));
  tumOgretmenler.length = 0;
  snap.forEach((d) => tumOgretmenler.push({ id: d.id, ...d.data() }));
  window.dropdownlariGuncelle?.();
  const container = document.getElementById("ayarOgretmenListesi");
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Henuz ogretmen eklenmemis</div>';
    return;
  }

  // Branşa göre grupla (normalize ederek)
  const bransGrup = {};
  tumOgretmenler.forEach((o) => {
    const brans = (window.bransNormalize?.(o.brans)) || o.brans || "Diğer";
    if (!bransGrup[brans]) bransGrup[brans] = [];
    bransGrup[brans].push(o);
  });

  let html = "";
  Object.keys(bransGrup)
    .sort((a, b) => a.localeCompare(b, "tr"))
    .forEach((brans) => {
      const liste = bransGrup[brans].sort((a, b) => (a.ad || "").localeCompare(b.ad || "", "tr"));
      const bransId = "brans-" + brans.replace(/[^a-zA-Z0-9]/g, "_");

      html += `<div style="margin-bottom:4px;">
        <div class="akor-kademe-baslik" onclick="akordiyonToggle('${bransId}')">
          <span>${brans} <span style="font-size:12px;font-weight:400;color:var(--text2);">(${liste.length} öğretmen)</span></span>
          <span id="ok-${bransId}" style="font-size:12px;color:var(--text2);">▶</span>
        </div>
        <div id="${bransId}" style="display:none;padding:2px 0 2px 0;">
          <table style="width:100%;"><tbody>`;

      liste.forEach((o) => {
        const adEsc = (o.ad || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
        const emailEsc = (o.email || "").replace(/"/g, "&quot;");
        html += `<tr>
          <td style="padding:8px 12px;"><strong>${o.ad}</strong></td>
          <td style="padding:8px 6px;color:var(--text2);font-size:13px;">${o.email}</td>
          <td style="padding:8px 12px;white-space:nowrap;text-align:right;">
            <button class="btn btn-gri btn-sm" onclick="ogretmenDuzenleAc('${o.id}')">Düzenle</button>
            <button class="btn btn-kirmizi btn-sm" onclick="ogretmenSil('${o.id}','${adEsc}')">Sil</button>
          </td>
        </tr>
        <tr id="edit-${o.id}" style="display:none;">
          <td colspan="3" style="padding:0;">
            <div style="padding:12px;background:#f8f9fa;border-top:1px solid var(--border);">
              <div class="form-grid" style="margin-bottom:8px;">
                <div class="form-group">
                  <label style="font-size:12px;">Ad Soyad</label>
                  <input id="edit-ad-${o.id}" value="${adEsc}" style="font-size:13px;">
                </div>
                <div class="form-group">
                  <label style="font-size:12px;">E-posta</label>
                  <input type="email" id="edit-email-${o.id}" value="${emailEsc}" style="font-size:13px;">
                </div>
                <div class="form-group">
                  <label style="font-size:12px;">Yeni Şifre <span style="font-weight:400;color:var(--text2);">(boş = değiştirme)</span></label>
                  <input type="password" id="edit-sifre-${o.id}" placeholder="Yeni şifre..." style="font-size:13px;">
                </div>
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <button class="btn btn-yesil btn-sm" onclick="ogretmenGuncelle('${o.id}')">Kaydet</button>
                <button class="btn btn-gri btn-sm" onclick="ogretmenDuzenleAc('${o.id}')">İptal</button>
                <span id="edit-mesaj-${o.id}" style="font-size:13px;"></span>
              </div>
            </div>
          </td>
        </tr>`;
      });

      html += `</tbody></table></div></div>`;
    });

  container.innerHTML = html;
}

window.branslarNormalizeEt = async function () {
  const { db, getDocs, updateDoc, collection, doc } = window.__portal;
  const snap = await getDocs(collection(db, "teachers"));
  const guncellemeler = [];
  snap.forEach((d) => {
    const mevcutBrans = d.data().brans;
    const yeniBrans = window.bransNormalize?.(mevcutBrans);
    if (yeniBrans && yeniBrans !== mevcutBrans)
      guncellemeler.push(updateDoc(doc(db, "teachers", d.id), { brans: yeniBrans }));
  });
  await Promise.all(guncellemeler);
  mesajGoster("bransNormalizeMesaj", guncellemeler.length + " öğretmen güncellendi.", "basari");
  await ogretmenleriListele();
};

window.ogretmenSil = async function (id, ad) {
  const { db, deleteDoc, doc } = window.__portal;
  if (!confirm('"' + ad + '" adli ogretmeni silmek istediginize emin misiniz?'))
    return;
  try {
    await deleteDoc(doc(db, "teachers", id));
    mesajGoster("ogretmenEkleMesaj", ad + " silindi.", "basari");
    await ogretmenleriListele();
  } catch (err) {
    mesajGoster("ogretmenEkleMesaj", "Hata: " + err.message, "hata");
  }
};

window.ogretmenDuzenleAc = function (id) {
  const row = document.getElementById("edit-" + id);
  if (!row) return;
  row.style.display = row.style.display === "none" ? "" : "none";
};

window.ogretmenGuncelle = async function (id) {
  const { functions, httpsCallable } = window.__portal;
  const ad = document.getElementById("edit-ad-" + id)?.value.trim();
  const email = document.getElementById("edit-email-" + id)?.value.trim();
  const sifre = document.getElementById("edit-sifre-" + id)?.value;
  const mesajEl = document.getElementById("edit-mesaj-" + id);
  if (!ad || !email) {
    if (mesajEl) mesajEl.innerHTML = '<span style="color:#ea4335;">Ad ve e-posta zorunlu.</span>';
    return;
  }
  if (mesajEl) mesajEl.innerHTML = '<span style="color:#1a73e8;">Kaydediliyor...</span>';
  try {
    const fn = httpsCallable(functions, "ogretmenGuncelle");
    const payload = { ogretmenId: id, ad, email };
    if (sifre) payload.sifre = sifre;
    await fn(payload);
    mesajGoster("ogretmenEkleMesaj", "Öğretmen bilgileri güncellendi.", "basari");
    await ogretmenleriListele();
  } catch (err) {
    if (mesajEl) mesajEl.innerHTML = '<span style="color:#ea4335;">Hata: ' + err.message + '</span>';
  }
};

window.ogretmenEkle = async function () {
  const { functions, httpsCallable } = window.__portal;
  const ad = document.getElementById("ayarOgretmenAd").value.trim();
  const brans = document.getElementById("ayarOgretmenBrans").value.trim();
  const email = document.getElementById("ayarOgretmenEmail").value.trim();
  const sifre = document.getElementById("ayarOgretmenSifre").value;
  if (!ad || !brans || !email || !sifre) {
    mesajGoster("ogretmenEkleMesaj", "Tum alanlari doldurun.", "hata");
    return;
  }
  mesajGoster("ogretmenEkleMesaj", "Ekleniyor...", "bilgi");
  try {
    const fn = httpsCallable(functions, "ogretmenOlustur");
    await fn({ ad, brans, email, sifre });
    mesajGoster("ogretmenEkleMesaj", "Ogretmen eklendi.", "basari");
    ["ayarOgretmenAd", "ayarOgretmenBrans", "ayarOgretmenEmail", "ayarOgretmenSifre"].forEach(
      (id) => (document.getElementById(id).value = ""),
    );
    await ogretmenleriListele();
  } catch (err) {
    mesajGoster("ogretmenEkleMesaj", "Hata: " + err.message, "hata");
  }
};

async function siniflariListele() {
  const { db, getDocs, collection, getTumSiniflar } = window.__portal;
  const tumSiniflar = getTumSiniflar();
  const snap = await getDocs(collection(db, "classes"));
  tumSiniflar.length = 0;
  snap.forEach((d) => tumSiniflar.push({ id: d.id, ...d.data() }));
  const container = document.getElementById("ayarSinifListesi");
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Henuz sinif eklenmemis</div>';
    return;
  }
  tumSiniflar.sort((a, b) =>
    a.grade !== b.grade
      ? a.grade - b.grade
      : a.class_name.localeCompare(b.class_name),
  );
  let html =
    "<table><thead><tr><th>Sinif Adi</th><th>Kademe</th><th></th></tr></thead><tbody>";
  tumSiniflar.forEach((s) => {
    html += `<tr><td><strong>${s.class_name}</strong></td><td>${s.grade}. Sinif</td><td><button class="btn btn-kirmizi btn-sm" onclick="sinifSil('${s.id}','${s.class_name}')">Sil</button></td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

window.sinifEkle = async function () {
  const { db, addDoc, collection, serverTimestamp } = window.__portal;
  const ad = document.getElementById("ayarSinifAd").value.trim().toUpperCase();
  const kademe = document.getElementById("ayarSinifKademe").value;
  if (!ad) {
    mesajGoster("sinifEkleMesaj", "Sinif adi girin.", "hata");
    return;
  }
  await addDoc(collection(db, "classes"), {
    class_name: ad,
    grade: parseInt(kademe),
    created_at: serverTimestamp(),
  });
  mesajGoster("sinifEkleMesaj", "Sinif eklendi.", "basari");
  document.getElementById("ayarSinifAd").value = "";
  await siniflariListele();
  await sinifDropdownlariniDoldur();
};

window.sinifSil = async function (id, isim) {
  const { db, deleteDoc, doc } = window.__portal;
  if (!confirm(`"${isim}" sinifini silmek istediginize emin misiniz?`)) return;
  try {
    await deleteDoc(doc(db, "classes", id));
    await siniflariListele();
    await sinifDropdownlariniDoldur();
  } catch (err) {
    mesajGoster("sinifEkleMesaj", "Hata: " + err.message, "hata");
  }
};

async function sinifDropdownlariniDoldur() {
  const { db, getDocs, collection } = window.__portal;
  const snap = await getDocs(collection(db, "classes"));
  let siniflar = [];
  snap.forEach((d) => siniflar.push(d.data()));
  siniflar.sort((a, b) => a.class_name.localeCompare(b.class_name));
  ["ayarOgrenciSinif", "ayarOgrenciSinifFiltre"].forEach((id) => {
    const el = document.getElementById(id);
    const ilk = id.includes("Filtre")
      ? '<option value="">Tum Siniflar</option>'
      : '<option value="">Sinif secin</option>';
    el.innerHTML = ilk;
    siniflar.forEach(
      (s) => (el.innerHTML += `<option value="${s.class_name}">${s.class_name}</option>`),
    );
  });
}

window.ogrencileriGetir = async function () {
  const { db, getDocs, collection, query, where } = window.__portal;
  const filtre = document.getElementById("ayarOgrenciSinifFiltre").value;
  const container = document.getElementById("ayarOgrenciListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  let q = filtre
    ? query(collection(db, "students"), where("class_id", "==", filtre))
    : collection(db, "students");
  const snap = await getDocs(q);
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Ogrenci bulunamadi</div>';
    return;
  }
  let ogrenciler = [];
  snap.forEach((d) => ogrenciler.push({ id: d.id, ...d.data() }));
  ogrenciler.sort((a, b) => a.student_number.localeCompare(b.student_number));
  let html =
    "<table><thead><tr><th>No</th><th>Ad Soyad</th><th>Sinif</th><th></th></tr></thead><tbody>";
  ogrenciler.forEach((o) => {
    html += `<tr><td>${o.student_number}</td><td>${o.name}</td><td>${o.class_id}</td><td><button class="btn btn-kirmizi btn-sm" onclick="ogrenciSil('${o.id}','${o.name}')">Sil</button></td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
};

window.ogrenciEkle = async function () {
  const { db, addDoc, collection, serverTimestamp } = window.__portal;
  const no = document.getElementById("ayarOgrenciNo").value.trim();
  const ad = document.getElementById("ayarOgrenciAd").value.trim();
  const sinif = document.getElementById("ayarOgrenciSinif").value;
  if (!no || !ad || !sinif) {
    mesajGoster("ogrenciEkleMesaj", "Tum alanlari doldurun.", "hata");
    return;
  }
  await addDoc(collection(db, "students"), {
    student_number: no,
    name: ad,
    class_id: sinif,
    status: "active",
    created_at: serverTimestamp(),
  });
  mesajGoster("ogrenciEkleMesaj", "Ogrenci eklendi.", "basari");
  document.getElementById("ayarOgrenciNo").value = "";
  document.getElementById("ayarOgrenciAd").value = "";
  window.ogrencileriGetir();
};

window.ogrenciSil = async function (id, isim) {
  const { db, deleteDoc, doc } = window.__portal;
  if (!confirm(`"${isim}" adli ogrenciyi silmek istediginize emin misiniz?`)) return;
  try {
    await deleteDoc(doc(db, "students", id));
    window.ogrencileriGetir();
  } catch (err) {
    mesajGoster("ogrenciEkleMesaj", "Hata: " + err.message, "hata");
  }
};

async function donemBilgisiniGetir() {
  const { db, getDoc, doc } = window.__portal;
  const ayarDoc = await getDoc(doc(db, "disiplin_ayarlar", "genel"));
  if (ayarDoc.exists())
    document.getElementById("aktifDonemSecim").value =
      ayarDoc.data().aktif_donem || "1";
}

window.donemGuncelle = async function () {
  const { db, getDoc, setDoc, doc, serverTimestamp } = window.__portal;
  const donem = document.getElementById("aktifDonemSecim").value;
  const ayarDoc = await getDoc(doc(db, "disiplin_ayarlar", "genel"));
  await setDoc(doc(db, "disiplin_ayarlar", "genel"), {
    ...(ayarDoc.exists() ? ayarDoc.data() : {}),
    aktif_donem: donem,
    guncelleme: serverTimestamp(),
  });
  mesajGoster("donemMesaj", donem + ". Donem aktif yapildi.", "basari");
};

window.sistemAyarlariniKaydet = async function () {
  const { db, setDoc, doc, serverTimestamp } = window.__portal;
  await setDoc(doc(db, "settings", "genel"), {
    lesson_duration:
      parseInt(document.getElementById("ayarDersSuresi").value) || 40,
    telegram_token: document.getElementById("ayarTelegram").value,
    updated_at: serverTimestamp(),
  });
  mesajGoster("sistemAyarMesaj", "Ayarlar kaydedildi.", "basari");
};

window.telegramTest = async function () {
  const { functions, httpsCallable } = window.__portal;
  mesajGoster("telegramTestMesaj", "Gonderiliyor...", "bilgi");
  try {
    const fn = httpsCallable(functions, "testBildirimiGonder");
    await fn({});
    mesajGoster("telegramTestMesaj", "Telegram mesaji gonderildi!", "basari");
  } catch (err) {
    mesajGoster("telegramTestMesaj", "Hata: " + err.message, "hata");
  }
};
