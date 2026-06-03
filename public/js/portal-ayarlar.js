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
  else if (id === "dersler") _dersListesiYukle();
  else if (id === "sifre-listesi") window.sifreListesiGoster();
  else if (id === "ogrenciler") window.ogrencileriGetir();
  else if (id === "ogretmen-sifre") window.ogretmenSifreListesiGoster();
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
            <button class="btn btn-mavi btn-sm" onclick="ogretmenOtoKimlikVer('${o.id}','${adEsc}')">Kimlik Ver</button>
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
  const { functions, httpsCallable } = window.__portal;
  if (!confirm('"' + ad + '" adli ogretmeni silmek istediginize emin misiniz?'))
    return;
  try {
    const ogretmenSilFn = httpsCallable(functions, "ogretmenSil");
    await ogretmenSilFn({ ogretmenId: id });
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

window.ogretmenOtoKimlikVer = async function (id, ad) {
  const { functions, httpsCallable } = window.__portal;
  const email = window.emailUret(ad);
  const sifre = window.sifreUret();
  if (!confirm(`"${ad}" için yeni kimlik atanacak:\nKullanıcı: ${email}\nŞifre: ${sifre}\n\nOnaylıyor musunuz?`)) return;
  try {
    const fn = httpsCallable(functions, "ogretmenGuncelle");
    await fn({ ogretmenId: id, email, sifre });
    alert(`Kimlik atandı!\nKullanıcı: ${email}\nŞifre: ${sifre}`);
    await ogretmenleriListele();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

window.ogretmenEmailOtoUret = function () {
  const ad = document.getElementById("ayarOgretmenAd")?.value.trim();
  if (ad) {
    document.getElementById("ayarOgretmenEmail").value = window.emailUret(ad);
    document.getElementById("ayarOgretmenSifre").value = window.sifreUret();
  }
};

window.ogretmenSifreListesiGoster = async function () {
  const { db, getDocs, collection } = window.__portal;
  const container = document.getElementById("ogretmen-sifre-listesi-icerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const snap = await getDocs(collection(db, "teachers"));
  const hesaplılar = [];
  snap.forEach(d => { const v = d.data(); if (v.kimlik_sifre) hesaplılar.push({ id: d.id, ...v }); });

  if (!hesaplılar.length) {
    container.innerHTML = '<div class="bos-mesaj">Henüz şifresi atanmış öğretmen yok.</div>';
    return;
  }

  hesaplılar.sort((a, b) => (a.brans||"").localeCompare(b.brans||"","tr") || (a.ad||"").localeCompare(b.ad||"","tr"));

  const bransGruplari = {};
  hesaplılar.forEach(o => {
    const b = o.brans || "Diğer";
    if (!bransGruplari[b]) bransGruplari[b] = [];
    bransGruplari[b].push(o);
  });

  let html = `<p style="font-size:13px;color:#888;margin-bottom:12px;">${hesaplılar.length} öğretmenin giriş bilgileri.</p>`;

  Object.entries(bransGruplari).sort((a,b) => a[0].localeCompare(b[0],"tr")).forEach(([brans, liste]) => {
    const bid = brans.replace(/[^a-zA-Z0-9]/g,"_");
    html += `<div class="accordion-item" style="margin-bottom:8px;">
      <div class="accordion-baslik print-show" style="cursor:pointer;" onclick="const ic=this.nextElementSibling;ic.style.display=ic.style.display==='none'?'block':'none';">
        <span><strong>${brans}</strong> <span style="font-size:12px;color:#888;">(${liste.length} öğretmen)</span></span>
        <span class="no-print">▼</span>
      </div>
      <div style="display:block;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#1557b0;color:white;">
            <th style="padding:8px;text-align:left;">Ad Soyad</th>
            <th style="padding:8px;text-align:left;">Kullanici Adi (E-posta)</th>
            <th style="padding:8px;text-align:left;">Sifre</th>
          </tr></thead><tbody>`;
    liste.forEach((o, i) => {
      html += `<tr style="${i%2===0?"background:#fafafa;":""}">
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-weight:600;">${o.ad||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-family:monospace;">${o.email||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:700;">${o.kimlik_sifre||""}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  container.innerHTML = html;
};

window.ogretmenEkle = async function () {
  const { functions, httpsCallable } = window.__portal;
  const ad = document.getElementById("ayarOgretmenAd").value.trim();
  const brans = document.getElementById("ayarOgretmenBrans").value.trim();
  let email = document.getElementById("ayarOgretmenEmail").value.trim();
  let sifre = document.getElementById("ayarOgretmenSifre").value.trim();
  if (!ad || !brans) {
    mesajGoster("ogretmenEkleMesaj", "Ad ve brans zorunludur.", "hata");
    return;
  }
  if (!email) email = window.emailUret(ad);
  if (!sifre) sifre = window.sifreUret();
  document.getElementById("ayarOgretmenEmail").value = email;
  document.getElementById("ayarOgretmenSifre").value = sifre;
  mesajGoster("ogretmenEkleMesaj", "Ekleniyor...", "bilgi");
  try {
    const fn = httpsCallable(functions, "ogretmenOlustur");
    await fn({ ad, brans, email, sifre });
    mesajGoster("ogretmenEkleMesaj", `Öğretmen eklendi. Kullanıcı: ${email} / Şifre: ${sifre}`, "basari");
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

// ── Yardımcı: email ve şifre üretici ──
window.emailUret = function (ad) {
  const isim = (ad || "").split(" ")[0].toLowerCase()
    .replace(/ş/g,"s").replace(/ç/g,"c").replace(/ğ/g,"g")
    .replace(/ü/g,"u").replace(/ö/g,"o").replace(/ı/g,"i")
    .replace(/İ/gi,"i").replace(/[^a-z]/g,"");
  return `${isim || "ogrenci"}${Math.floor(1000 + Math.random() * 9000)}@gmail.com`;
};
window.sifreUret = function () {
  return String(Math.floor(100000 + Math.random() * 900000));
};
window.ogrenciEmailOtoUret = function () {
  const ad = document.getElementById("ayarOgrenciAd")?.value.trim();
  if (ad) {
    document.getElementById("ayarOgrenciEmail").value = window.emailUret(ad);
    document.getElementById("ayarOgrenciSifre").value = window.sifreUret();
  }
};

// ── Öğrenci Listesi — sınıfa göre accordion ──
window.ogrencileriGetir = async function () {
  const { db, getDocs, collection, httpsCallable, functions } = window.__portal;
  const container = document.getElementById("ayarOgrenciListesi");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const snap = await getDocs(collection(db, "students"));
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Ogrenci bulunamadi</div>'; return; }

  const ogrenciler = [];
  snap.forEach(d => ogrenciler.push({ id: d.id, ...d.data() }));
  ogrenciler.sort((a, b) => (a.class_id||"").localeCompare(b.class_id||"","tr") || (a.name||"").localeCompare(b.name||"","tr"));

  const sinifGruplari = {};
  ogrenciler.forEach(o => {
    const s = o.class_id || "Sinıfsız";
    if (!sinifGruplari[s]) sinifGruplari[s] = [];
    sinifGruplari[s].push(o);
  });

  const hesapVar = ogrenciler.filter(o => o.kimlik_email).length;
  let html = `<div style="font-size:13px;color:#555;margin-bottom:12px;">
    Toplam: <strong>${ogrenciler.length}</strong> öğrenci &nbsp;|&nbsp;
    <span style="color:#34a853;">✅ Hesabı var: <strong>${hesapVar}</strong></span> &nbsp;|&nbsp;
    <span style="color:#ea4335;">⚪ Hesabı yok: <strong>${ogrenciler.length - hesapVar}</strong></span>
  </div>`;

  Object.entries(sinifGruplari).sort((a,b) => a[0].localeCompare(b[0],"tr")).forEach(([sinif, liste]) => {
    const sinifId = sinif.replace(/[^a-zA-Z0-9]/g,"_");
    html += `<div class="accordion-item" style="margin-bottom:6px;">
      <div class="accordion-baslik" style="cursor:pointer;" onclick="const ic=this.nextElementSibling;ic.style.display=ic.style.display==='none'?'block':'none';">
        <span>📚 ${sinif} <span style="font-size:12px;color:#888;">(${liste.length} öğrenci)</span></span>
        <span>▼</span>
      </div>
      <div class="accordion-icerik" style="display:none;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f8f9fa;">
            <th style="padding:7px;text-align:left;border-bottom:1px solid #e0e0e0;">Ad Soyad</th>
            <th style="padding:7px;text-align:left;border-bottom:1px solid #e0e0e0;">No</th>
            <th style="padding:7px;text-align:left;border-bottom:1px solid #e0e0e0;">Hesap</th>
            <th style="padding:7px;border-bottom:1px solid #e0e0e0;"></th>
          </tr></thead><tbody>`;
    liste.forEach(o => {
      const hesapBilgi = o.kimlik_email
        ? `<span class="rozet rozet-yesil" style="font-size:11px;">✓ ${o.kimlik_email}</span>`
        : `<span class="rozet rozet-gri" style="font-size:11px;">Hesap Yok</span>`;
      html += `<tr>
        <td style="padding:7px;border-bottom:1px solid #f5f5f5;">${o.name}</td>
        <td style="padding:7px;border-bottom:1px solid #f5f5f5;">${o.student_number||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f5f5f5;">${hesapBilgi}</td>
        <td style="padding:7px;border-bottom:1px solid #f5f5f5;white-space:nowrap;">
          <button class="btn btn-mavi btn-sm" onclick="ogrenciHesapVer('${o.id}','${(o.name||"").replace(/'/g,"\\'")}')">
            ${o.kimlik_email ? "Yenile" : "Hesap Aç"}
          </button>
          <button class="btn btn-kirmizi btn-sm" onclick="ogrenciSil('${o.id}','${(o.name||"").replace(/'/g,"\\'")}')">Sil</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  container.innerHTML = html;
};

// ── Yeni öğrenci ekle + hesap oluştur ──
window.ogrenciEkle = async function () {
  const { db, addDoc, collection, serverTimestamp, httpsCallable, functions } = window.__portal;
  const no = document.getElementById("ayarOgrenciNo").value.trim();
  const ad = document.getElementById("ayarOgrenciAd").value.trim();
  const sinif = document.getElementById("ayarOgrenciSinif").value;
  let email = document.getElementById("ayarOgrenciEmail").value.trim();
  let sifre = document.getElementById("ayarOgrenciSifre").value.trim();

  if (!no || !ad || !sinif) { mesajGoster("ogrenciEkleMesaj", "No, ad ve sinif zorunludur.", "hata"); return; }
  if (!email) email = window.emailUret(ad);
  if (!sifre) sifre = window.sifreUret();
  if (sifre.length < 5) { mesajGoster("ogrenciEkleMesaj", "Sifre en az 5 karakter olmali.", "hata"); return; }

  mesajGoster("ogrenciEkleMesaj", "Ogrenci ekleniyor...", "bilgi");
  try {
    const docRef = await addDoc(collection(db, "students"), {
      student_number: no, name: ad, class_id: sinif,
      status: "active", created_at: serverTimestamp(),
    });
    const fn = httpsCallable(functions, "ogrenciHesapOlustur");
    await fn({ ogrenciId: docRef.id, email, sifre });
    mesajGoster("ogrenciEkleMesaj", `Eklendi! Kullanici: ${email} / Sifre: ${sifre}`, "basari");
    document.getElementById("ayarOgrenciNo").value = "";
    document.getElementById("ayarOgrenciAd").value = "";
    document.getElementById("ayarOgrenciEmail").value = "";
    document.getElementById("ayarOgrenciSifre").value = "";
    window.ogrencileriGetir();
  } catch (err) {
    mesajGoster("ogrenciEkleMesaj", "Hata: " + err.message, "hata");
  }
};

// ── Var olan öğrenciye hesap ver / yenile ──
window.ogrenciHesapVer = async function (ogrenciId, isim) {
  const { httpsCallable, functions } = window.__portal;
  const email = window.emailUret(isim);
  const sifre = window.sifreUret();
  if (!confirm(`"${isim}" için hesap oluşturulacak:\nKullanıcı: ${email}\nŞifre: ${sifre}\n\nOnayla?`)) return;
  try {
    const fn = httpsCallable(functions, "ogrenciHesapOlustur");
    await fn({ ogrenciId, email, sifre });
    window.ogrencileriGetir();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// ── Öğrenci sil (Auth + users + students) ──
window.ogrenciSil = async function (id, isim) {
  const { httpsCallable, functions } = window.__portal;
  if (!confirm(`"${isim}" adli ogrenciyi ve hesabini tamamen silmek istiyor musunuz?`)) return;
  try {
    const fn = httpsCallable(functions, "ogrenciSilTamamen");
    await fn({ ogrenciId: id });
    window.ogrencileriGetir();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// ── Toplu hesap oluştur ──
window.tumOgrencilereHesapAc = async function () {
  const { db, getDocs, collection, httpsCallable, functions } = window.__portal;
  const ilerlemeEl = document.getElementById("topluOgrenciIlerleme");

  const snap = await getDocs(collection(db, "students"));
  const hesapsizlar = [];
  snap.forEach(d => { if (!d.data().kimlik_email) hesapsizlar.push({ id: d.id, ...d.data() }); });

  if (!hesapsizlar.length) { alert("Tüm öğrencilerin hesabı zaten mevcut."); return; }
  if (!confirm(`${hesapsizlar.length} öğrenciye hesap oluşturulacak. Bu işlem biraz sürebilir. Devam?`)) return;

  ilerlemeEl.style.display = "block";
  const fn = httpsCallable(functions, "ogrenciHesapOlustur");
  let tamamlanan = 0, hata = 0;

  for (const o of hesapsizlar) {
    ilerlemeEl.textContent = `⏳ İşleniyor: ${tamamlanan} / ${hesapsizlar.length}`;
    const email = window.emailUret(o.name || "ogrenci");
    const sifre = window.sifreUret();
    try {
      await fn({ ogrenciId: o.id, email, sifre });
      tamamlanan++;
    } catch (e) { hata++; }
  }

  ilerlemeEl.textContent = `✅ Tamamlandı: ${tamamlanan} hesap oluşturuldu${hata ? ` (${hata} hata)` : ""}.`;
  window.ogrencileriGetir();
};

// ── Şifre Listesi ──
window.sifreListesiGoster = async function () {
  const { db, getDocs, collection } = window.__portal;
  const container = document.getElementById("sifre-listesi-icerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const snap = await getDocs(collection(db, "students"));
  const hesaplılar = [];
  snap.forEach(d => { const v = d.data(); if (v.kimlik_email) hesaplılar.push({ id: d.id, ...v }); });

  if (!hesaplılar.length) {
    container.innerHTML = '<div class="bos-mesaj">Henüz hesabı olan öğrenci yok.</div>';
    return;
  }

  hesaplılar.sort((a, b) => (a.class_id||"").localeCompare(b.class_id||"","tr") || (a.name||"").localeCompare(b.name||"","tr"));

  const sinifGruplari = {};
  hesaplılar.forEach(o => {
    const s = o.class_id || "Sinıfsız";
    if (!sinifGruplari[s]) sinifGruplari[s] = [];
    sinifGruplari[s].push(o);
  });

  let html = `<p style="font-size:13px;color:#888;margin-bottom:12px;">${hesaplılar.length} öğrencinin giriş bilgileri.</p>`;

  Object.entries(sinifGruplari).sort((a,b) => a[0].localeCompare(b[0],"tr")).forEach(([sinif, liste]) => {
    const sinifId = sinif.replace(/[^a-zA-Z0-9]/g,"_");
    html += `<div class="accordion-item" style="margin-bottom:8px;">
      <div class="accordion-baslik print-show" style="cursor:pointer;" onclick="const ic=this.nextElementSibling;ic.style.display=ic.style.display==='none'?'block':'none';">
        <span><strong>${sinif}</strong> <span style="font-size:12px;color:#888;">(${liste.length} öğrenci)</span></span>
        <span class="no-print">▼</span>
      </div>
      <div class="accordion-icerik" style="display:block;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#1557b0;color:white;">
            <th style="padding:8px;text-align:left;">No</th>
            <th style="padding:8px;text-align:left;">Ad Soyad</th>
            <th style="padding:8px;text-align:left;">Kullanici Adi (E-posta)</th>
            <th style="padding:8px;text-align:left;">Sifre</th>
          </tr></thead><tbody>`;
    liste.forEach((o, i) => {
      html += `<tr style="${i%2===0?"background:#fafafa;":""}">
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;">${o.student_number||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-weight:600;">${o.name||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-family:monospace;">${o.kimlik_email||""}</td>
        <td style="padding:7px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-weight:700;">${o.kimlik_sifre||""}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  container.innerHTML = html;
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

async function _dersListesiYukle() {
  const { db, getDocs, collection } = window.__portal;
  const snap = await getDocs(collection(db, "ders_listesi"));
  const dersler = [];
  snap.forEach((d) => dersler.push({ id: d.id, ...d.data() }));
  dersler.sort((a, b) => (a.ders_adi || "").localeCompare(b.ders_adi || "", "tr"));

  const c = document.getElementById("asekme-dersler");
  let html = `<div class="kart"><div class="kart-baslik">Ders Listesi</div>`;
  if (dersler.length) {
    html += `<table><thead><tr><th>Ders Adı</th><th></th></tr></thead><tbody>`;
    dersler.forEach((d) => {
      html += `<tr><td><strong>${d.ders_adi}</strong></td><td style="text-align:right;"><button class="btn btn-kirmizi btn-sm" onclick="dersListesiSil('${d.id}')">Sil</button></td></tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="bos-mesaj">Henuz ders eklenmemis.</div>`;
  }
  html += `<div style="margin-top:16px;display:flex;gap:10px;align-items:flex-end;">
    <div class="form-group" style="margin-bottom:0;flex:1;">
      <label>Ders Adı</label>
      <input type="text" id="yeniDersListesiInput" placeholder="Matematik">
    </div>
    <button class="btn btn-yesil" onclick="dersListesiEkle()">+ Ekle</button>
  </div>
  <div class="mesaj" id="dersListesiMesaj"></div></div>`;
  c.innerHTML = html;
}

window.dersListesiEkle = async function () {
  const { db, addDoc, collection, serverTimestamp } = window.__portal;
  const ad = document.getElementById("yeniDersListesiInput")?.value?.trim();
  if (!ad) { mesajGoster("dersListesiMesaj", "Ders adı girin.", "hata"); return; }
  await addDoc(collection(db, "ders_listesi"), { ders_adi: ad, olusturulma: serverTimestamp() });
  mesajGoster("dersListesiMesaj", "Ders eklendi.", "basari");
  document.getElementById("yeniDersListesiInput").value = "";
  _dersListesiYukle();
};

window.dersListesiSil = async function (id) {
  const { db, deleteDoc, doc } = window.__portal;
  if (!confirm("Bu dersi silmek istediginize emin misiniz?")) return;
  await deleteDoc(doc(db, "ders_listesi", id));
  _dersListesiYukle();
};
