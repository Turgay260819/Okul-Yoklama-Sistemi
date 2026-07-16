import {
  db, functions, bugun,
  getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, doc, serverTimestamp, httpsCallable,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc, mesajGoster, tarihEkle, sor, bransNormalize, sor_giris } from "./portal-utils.js";

// ── GÖREV SAYFASI ──
export function gorevSayfasiBaslat() {
  gorevleriniYukle();
  _branslariDoldur();
}
window.gorevSayfasiBaslat = gorevSayfasiBaslat;

function _branslariDoldur() {
  const select = document.getElementById("gorevBrans");
  const branslar = [...new Set(state.ogretmenler.map((o) => bransNormalize(o.brans)).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Brans secin...</option>';
  branslar.forEach((b) => (select.innerHTML += `<option value="${b}">${esc(b)}</option>`));
}

window.gorevSekme = (id, el) => {
  document.querySelectorAll("#sayfa-gorev .sekme-icerik").forEach((s) => s.classList.remove("aktif"));
  document.querySelectorAll("#sayfa-gorev .sekme-btn").forEach((b) => b.classList.remove("aktif"));
  document.getElementById("gsekme-" + id).classList.add("aktif");
  el.classList.add("aktif");
  if (id === "liste") gorevleriniYukle();
  else if (id === "siralar") _siralariYukle();
  else if (id === "istatistik") _gorevIstatistikYukle();
  else if (id === "raporlar") _gorevRaporlariYukle();
  else if (id === "takvim") _kilitliGunleriYukle();
};

window.gorevTurDegisti = () => {
  document.getElementById("gorevBransRow").style.display =
    document.getElementById("gorevTur").value === "brans" ? "block" : "none";
};

export async function gorevleriniYukle() {
  const container = document.getElementById("gorevListesiIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(
    query(collection(db, "gorevler"), orderBy("olusturulma_tarihi", "desc")),
  );
  state.gorevler = [];
  snap.forEach((d) => state.gorevler.push({ id: d.id, ...d.data() }));
  _gorevleriniRender();
}
window.gorevleriniYukle = gorevleriniYukle;

window.gorevFiltrele = (filtre, el) => {
  state.gorevFiltresi = filtre;
  document.querySelectorAll("#gsekme-liste .btn").forEach((b) => { b.style.background = ""; b.style.color = ""; });
  el.style.background = "var(--mavi)";
  el.style.color = "white";
  _gorevleriniRender();
};

function _gorevleriniRender() {
  const container = document.getElementById("gorevListesiIcerik");
  const liste = state.gorevFiltresi === "hepsi"
    ? state.gorevler
    : state.gorevler.filter((g) => g.durum === state.gorevFiltresi);
  if (!liste.length) { container.innerHTML = '<div class="bos-mesaj">Gorev bulunamadi.</div>'; return; }

  const durumEtiket = { acik: "Acik", tamamlandi: "Tamamlandi", tamamlanmadi: "Tamamlanmadi", iptal: "Iptal" };
  const durumRozet = { acik: "rozet-mavi", tamamlandi: "rozet-yesil", tamamlanmadi: "rozet-kirmizi", iptal: "rozet-gri" };

  let html = "";
  liste.forEach((g) => {
    const atanenAdlar = (g.atananlar || []).join(", ") || "—";
    const gecti = g.son_tarih && g.son_tarih < bugun && g.durum === "acik";
    html += `<div class="gorev-kart ${g.durum || "acik"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div class="gorev-baslik">${esc(g.baslik)}</div>
        <span class="rozet ${durumRozet[g.durum] || "rozet-mavi"}">${durumEtiket[g.durum] || "Acik"}</span>
      </div>
      <div class="gorev-meta">
        <span>👤 ${esc(atanenAdlar)}</span>
        <span>📅 Son: <strong ${gecti ? 'style="color:var(--kirmizi)"' : ""}>${esc(g.son_tarih || "—")}${gecti ? " ⚠️" : ""}</strong></span>
        <span>${g.tur === "brans" ? "🎓 Brans: " + esc(g.brans) : "📌 Genel"}</span>
      </div>
      ${g.aciklama ? `<p style="font-size:13px;color:var(--text2);margin-bottom:8px;">${esc(g.aciklama)}</p>` : ""}
      <div class="gorev-butonlar">
        ${g.durum === "acik" && state.rol === "admin"
          ? `<button class="btn btn-yesil btn-sm" onclick="gorevOnayAc('${g.id}','tamamlandi')">✓ Tamamlandi</button>
             <button class="btn btn-kirmizi btn-sm" onclick="gorevOnayAc('${g.id}','tamamlanmadi')">✗ Tamamlanmadi</button>`
          : ""}
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

window.gorevOnayAc = (gorevId, tip) => {
  state.gorevOnayPendingId = gorevId;
  state.gorevOnayTip = tip;
  const gorev = state.gorevler.find((g) => g.id === gorevId);
  const baslik = tip === "tamamlandi" ? "✅ Gorev Tamamlandi" : "❌ Tamamlanmadi";
  const aciklama = tip === "tamamlandi"
    ? `"${gorev?.baslik}" gorevi tamamlandi olarak isaretlenecek.`
    : `"${gorev?.baslik}" gorevi tamamlanmadi olarak isaretlenecek. Atanan ogretmen bir sonraki gorevde once alinacak.`;
  document.getElementById("gorevOnayBaslik").textContent = baslik;
  document.getElementById("gorevOnayAciklama").textContent = aciklama;
  const btn = document.getElementById("gorevOnayBtn");
  btn.textContent = tip === "tamamlandi" ? "✓ Onayla" : "✗ Onayla";
  btn.className = "btn " + (tip === "tamamlandi" ? "btn-yesil" : "btn-kirmizi");
  document.getElementById("gorevOnayModal").classList.add("aktif");
};

window.gorevOnaylaConfirm = async () => {
  if (!state.gorevOnayPendingId) return;
  try {
    await updateDoc(doc(db, "gorevler", state.gorevOnayPendingId), {
      durum: state.gorevOnayTip,
      kapatma_tarihi: bugun,
      kapatma_notu: state.gorevOnayTip === "tamamlanmadi" ? "Tamamlanmadi olarak isaretlendi." : "",
    });
    if (state.gorevOnayTip === "tamamlanmadi") {
      const gorev = state.gorevler.find((g) => g.id === state.gorevOnayPendingId);
      for (const tid of gorev?.atanan_ids || []) {
        await addDoc(collection(db, "oncelik_kuyrugu"), {
          ogretmen_id: tid, sebep: "tamamlanmadi", kaynak_gorev_id: state.gorevOnayPendingId,
          kullanildi: false, olusturulma_tarihi: bugun,
        });
      }
    }
    window.modalKapat2();
    await gorevleriniYukle();
  } catch (err) {
    console.error("Görev onaylama hatası:", err);
  }
};

window.gorevOlustur = async () => {
  const baslik = document.getElementById("gorevBaslik").value.trim();
  const aciklama = document.getElementById("gorevAciklama").value.trim();
  const tur = document.getElementById("gorevTur").value;
  const brans = document.getElementById("gorevBrans").value;
  const sayi = parseInt(document.getElementById("gorevSayi").value) || 1;
  const sonTarih = document.getElementById("gorevSonTarih").value;

  if (!baslik) { mesajGoster("gorevOlusturMesaj", "Gorev basligi gerekli.", "hata"); return; }
  if (!sonTarih) { mesajGoster("gorevOlusturMesaj", "Son tarih gerekli.", "hata"); return; }
  if (tur === "brans" && !brans) { mesajGoster("gorevOlusturMesaj", "Brans secin.", "hata"); return; }

  const kilitSnap = await getDocs(
    query(collection(db, "takvim_kilidi"), where("tarih", "==", bugun)),
  );
  if (!kilitSnap.empty) { mesajGoster("gorevOlusturMesaj", "Bugun gorev atamasina kapali bir gun.", "hata"); return; }

  mesajGoster("gorevOlusturMesaj", "Atama yapiliyor...", "bilgi");
  try {
    const atananlar = await _gorevAtamaAlgoritm(tur, brans, sayi);
    if (!atananlar.length) {
      mesajGoster("gorevOlusturMesaj", "Uygun ogretmen bulunamadi. Tum ogretmenler cooldown surecinde olabilir.", "hata");
      return;
    }
    const atananAdlar = atananlar.map((a) => a.ad);
    const atananIds = atananlar.map((a) => a.id);
    const gorevRef = await addDoc(collection(db, "gorevler"), {
      baslik, aciklama, tur, brans: tur === "brans" ? brans : "", sayi, son_tarih: sonTarih,
      durum: "acik", atananlar: atananAdlar, atanan_ids: atananIds,
      olusturan_id: state.kullanici?.uid || "", olusturan_ad: state.kullanici?.ad || "",
      olusturulma_tarihi: bugun, kapatma_tarihi: "", kapatma_notu: "",
    });
    const cooldownBitis = tarihEkle(bugun, 30);
    for (const ogr of atananlar) {
      const siraSnap = await getDocs(
        query(collection(db, "ogretmen_sirasi"), where("ogretmen_id", "==", ogr.id), where("sira_turu", "==", tur === "brans" ? "brans_" + brans : "genel")),
      );
      if (!siraSnap.empty) {
        await updateDoc(siraSnap.docs[0].ref, { son_atama: bugun, cooldown_bitis: cooldownBitis });
      }
      const oncelikSnap = await getDocs(
        query(collection(db, "oncelik_kuyrugu"), where("ogretmen_id", "==", ogr.id), where("kullanildi", "==", false)),
      );
      for (const d of oncelikSnap.docs) {
        await updateDoc(d.ref, { kullanildi: true, kullanim_tarihi: bugun });
      }
    }
    try {
      const fn = httpsCallable(functions, "gorevAtandiBildir");
      fn({ baslik, aciklama, atananlar: atananAdlar, sonTarih, olusturanAd: state.kullanici?.ad || "" });
    } catch {}
    for (const ogretmenId of atananIds) {
      addDoc(collection(db, "bildirimler"), {
        alici_id: ogretmenId, tip: "gorev", baslik: `Yeni görev: ${baslik}`,
        mesaj: aciklama || `Son tarih: ${sonTarih}`, referans_id: gorevRef.id,
        okundu: false, tarih: serverTimestamp(),
      }).catch(() => {});
    }
    mesajGoster("gorevOlusturMesaj", `Gorev olusturuldu. Atanan: ${atananAdlar.join(", ")}`, "basari");
    document.getElementById("gorevBaslik").value = "";
    document.getElementById("gorevAciklama").value = "";
  } catch (err) {
    mesajGoster("gorevOlusturMesaj", "Hata: " + err.message, "hata");
  }
};

async function _gorevAtamaAlgoritm(tur, brans, sayi) {
  const siraKey = tur === "brans" ? "brans_" + brans : "genel";
  let havuz = tur === "brans" ? state.ogretmenler.filter((o) => bransNormalize(o.brans) === brans) : [...state.ogretmenler];

  const [oncelikSnap, siraSnap, acikGorevSnap, raporSnap] = await Promise.all([
    getDocs(query(collection(db, "oncelik_kuyrugu"), where("kullanildi", "==", false))),
    getDocs(query(collection(db, "ogretmen_sirasi"), where("sira_turu", "==", siraKey))),
    getDocs(query(collection(db, "gorevler"), where("durum", "==", "acik"))),
    getDocs(collection(db, "ogretmen_rapor")),
  ]);

  const oncelikIds = new Set();
  oncelikSnap.forEach((d) => oncelikIds.add(d.data().ogretmen_id));
  const siraMap = {};
  siraSnap.forEach((d) => (siraMap[d.data().ogretmen_id] = d.data()));
  const acikGorevOgretmenler = new Set();
  acikGorevSnap.forEach((d) => (d.data().atanan_ids || []).forEach((id) => acikGorevOgretmenler.add(id)));
  const raporlar = [];
  raporSnap.forEach((d) => raporlar.push(d.data()));

  function raporluMu(ogretmenId) {
    return raporlar.some((r) => r.ogretmen_id === ogretmenId && r.baslangic_tarihi <= bugun && r.bitis_tarihi >= bugun);
  }

  function uygunMu(ogr, atlaKooldown = false) {
    if (acikGorevOgretmenler.has(ogr.id)) return false;
    if (raporluMu(ogr.id)) return false;
    if (!atlaKooldown && siraMap[ogr.id]?.cooldown_bitis >= bugun) return false;
    return true;
  }

  const secilen = [];
  for (const ogr of havuz) {
    if (secilen.length >= sayi) break;
    if (oncelikIds.has(ogr.id) && uygunMu(ogr, true)) secilen.push(ogr);
  }
  const sirasiyla = havuz
    .filter((o) => !secilen.find((s) => s.id === o.id))
    .sort((a, b) => {
      const sa = siraMap[a.id]?.son_atama || "0000-00-00";
      const sb = siraMap[b.id]?.son_atama || "0000-00-00";
      return sa !== sb ? sa.localeCompare(sb) : (a.ad || "").localeCompare(b.ad || "", "tr");
    });
  for (const ogr of sirasiyla) {
    if (secilen.length >= sayi) break;
    if (uygunMu(ogr)) secilen.push(ogr);
  }
  for (const ogr of secilen) {
    if (!siraMap[ogr.id]) {
      await addDoc(collection(db, "ogretmen_sirasi"), {
        ogretmen_id: ogr.id, ogretmen_ad: ogr.ad, sira_turu: siraKey,
        son_atama: bugun, cooldown_bitis: tarihEkle(bugun, 30),
      });
    }
  }
  return secilen;
}

// ── SIRALAR ──
let _guncelSiraTuru = "genel";

async function _siralariYukle() {
  const container = document.getElementById("siraListesiIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
    const [siraSnap, raporSnap] = await Promise.all([
      getDocs(collection(db, "ogretmen_sirasi")),
      getDocs(collection(db, "ogretmen_rapor")),
    ]);
    const siralar = [];
    siraSnap.forEach((d) => siralar.push({ id: d.id, ...d.data() }));
    const raporlar = [];
    raporSnap.forEach((d) => raporlar.push({ id: d.id, ...d.data() }));

    // Sekmeleri: mevcut sıra türleri + genel (her zaman göster)
    const turler = [...new Set(["genel", ...siralar.map((s) => s.sira_turu)])].sort();
    const tabBar = document.getElementById("siraTabBar");
    tabBar.innerHTML = turler.map((t, i) =>
      `<button class="sekme-btn ${i === 0 ? "aktif" : ""}" onclick="siraTabGoster('${esc(t)}',this)">${t === "genel" ? "Genel Sira" : esc(t.replace("brans_", ""))}</button>`,
    ).join("");
    _guncelSiraTuru = turler[0];
    _siraTabGosterIcerik(turler[0], siralar, raporlar);
  } catch (err) {
    container.innerHTML = `<div class="bos-mesaj" style="color:#ea4335;">Hata: ${esc(err.message)}</div>`;
  }
}

window.siraTabGoster = (tur, el) => {
  _guncelSiraTuru = tur;
  document.querySelectorAll("#siraTabBar .sekme-btn").forEach((b) => b.classList.remove("aktif"));
  el.classList.add("aktif");
  Promise.all([
    getDocs(collection(db, "ogretmen_sirasi")),
    getDocs(collection(db, "ogretmen_rapor")),
  ]).then(([siraSnap, raporSnap]) => {
    const siralar = [];
    siraSnap.forEach((d) => siralar.push({ id: d.id, ...d.data() }));
    const raporlar = [];
    raporSnap.forEach((d) => raporlar.push({ id: d.id, ...d.data() }));
    _siraTabGosterIcerik(tur, siralar, raporlar);
  });
};

function _siraTabGosterIcerik(tur, siralar, raporlar) {
  const container = document.getElementById("siraListesiIcerik");
  const isAdmin = state.rol === "admin" || state.rol === "mudur_yardimcisi";

  // Sıra kaydı olan öğretmenler bu tur için
  const siraMap = {};
  siralar.filter((s) => s.sira_turu === tur).forEach((s) => (siraMap[s.ogretmen_id] = s));

  // Aktif raporlu öğretmenler
  const raporluIds = new Set(
    raporlar.filter((r) => r.baslangic_tarihi <= bugun && r.bitis_tarihi >= bugun).map((r) => r.ogretmen_id)
  );
  const raporMap = {};
  raporlar.forEach((r) => {
    if (!raporMap[r.ogretmen_id]) raporMap[r.ogretmen_id] = [];
    raporMap[r.ogretmen_id].push(r);
  });

  // Tüm öğretmenler: sıra kaydı olanlar önce (son_atama'ya göre), olmayanlar sona
  const siraKayitlilar = Object.values(siraMap).sort((a, b) => (a.son_atama || "").localeCompare(b.son_atama || ""));
  const siraKayitliIds = new Set(siraKayitlilar.map((s) => s.ogretmen_id));
  const kayitsizlar = state.ogretmenler.filter((o) => !siraKayitliIds.has(o.id));

  let html = "";
  let siradakiBulundu = false;

  siraKayitlilar.forEach((s, i) => {
    const cooldownVar = s.cooldown_bitis && s.cooldown_bitis >= bugun;
    const raporlu = raporluIds.has(s.ogretmen_id);
    const siradaki = !siradakiBulundu && !cooldownVar && !raporlu;
    if (siradaki) siradakiBulundu = true;
    const ogrRaporlari = raporMap[s.ogretmen_id] || [];
    html += `<div class="sira-item">
      <div class="sira-no ${siradaki ? "siradaki" : ""}">${i + 1}</div>
      <div class="sira-isim">${esc(s.ogretmen_ad)}</div>
      <div class="sira-meta">
        ${raporlu ? '<span class="rozet rozet-kirmizi">🏥 Raporlu</span>' : ""}
        ${cooldownVar && !raporlu ? `<span class="rozet rozet-sari">⏳ ${esc(s.cooldown_bitis)} kadar</span>` : ""}
        ${siradaki ? '<span class="rozet rozet-mavi">Siradaki</span>' : ""}
        ${!raporlu && !cooldownVar && !siradaki ? `<span style="color:var(--text2);font-size:12px;">Son: ${esc(s.son_atama || "—")}</span>` : ""}
        ${ogrRaporlari.map((r) => `<span style="font-size:11px;color:#888;">${esc(r.baslangic_tarihi)}–${esc(r.bitis_tarihi)}</span>`).join("")}
      </div>
      ${isAdmin ? `<div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="btn btn-sm" style="background:#fff0f0;color:#c62828;border:1px solid #ffcdd2;" onclick="raporEkleAc('${esc(s.ogretmen_id)}','${esc(s.ogretmen_ad)}')">🏥 Rapor</button>
        <button class="btn btn-kirmizi btn-sm" onclick="siraKaydiniSil('${esc(s.id)}','${esc(s.ogretmen_ad)}')">Sil</button>
      </div>` : ""}
    </div>`;
  });

  if (kayitsizlar.length) {
    html += `<div style="margin-top:12px;padding:8px 12px;background:#f8f9fa;border-radius:6px;font-size:12px;color:var(--text2);">Henüz görev almamış öğretmenler (sonraki görevde listeye girer):</div>`;
    kayitsizlar.forEach((o) => {
      const raporlu = raporluIds.has(o.id);
      const ogrRaporlari = raporMap[o.id] || [];
      html += `<div class="sira-item" style="opacity:0.7;">
        <div class="sira-no">—</div>
        <div class="sira-isim">${esc(o.ad)}</div>
        <div class="sira-meta">
          ${raporlu ? '<span class="rozet rozet-kirmizi">🏥 Raporlu</span>' : '<span style="color:var(--text2);font-size:12px;">Henuz gorev almadi</span>'}
          ${ogrRaporlari.map((r) => `<span style="font-size:11px;color:#888;">${esc(r.baslangic_tarihi)}–${esc(r.bitis_tarihi)}</span>`).join("")}
        </div>
        ${isAdmin ? `<div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn btn-sm" style="background:#fff0f0;color:#c62828;border:1px solid #ffcdd2;" onclick="raporEkleAc('${esc(o.id)}','${esc(o.ad)}')">🏥 Rapor</button>
        </div>` : ""}
      </div>`;
    });
  }

  container.innerHTML = html || '<div class="bos-mesaj">Ogretmen bulunamadi.</div>';
}

// Rapor ekleme
let _raporPendingId = null;
window.raporEkleAc = (ogretmenId, ogretmenAd) => {
  _raporPendingId = { id: ogretmenId, ad: ogretmenAd };
  document.getElementById("raporOgretmenAdi").textContent = ogretmenAd;
  document.getElementById("raporBaslangic").value = bugun;
  document.getElementById("raporBitis").value = bugun;
  document.getElementById("raporAciklama").value = "";
  document.getElementById("raporModalMesaj").style.display = "none";
  document.getElementById("raporModal").classList.add("aktif");
};

window.raporKaydet = async () => {
  if (!_raporPendingId) return;
  const bas = document.getElementById("raporBaslangic").value;
  const bit = document.getElementById("raporBitis").value;
  const aciklama = document.getElementById("raporAciklama").value.trim();
  if (!bas || !bit || bit < bas) {
    mesajGoster("raporModalMesaj", "Gecerli tarih araligi girin.", "hata");
    return;
  }
  await addDoc(collection(db, "ogretmen_rapor"), {
    ogretmen_id: _raporPendingId.id,
    ogretmen_ad: _raporPendingId.ad,
    baslangic_tarihi: bas,
    bitis_tarihi: bit,
    aciklama,
    olusturulma: serverTimestamp(),
  });
  document.getElementById("raporModal").classList.remove("aktif");
  _raporPendingId = null;
  siraTabGoster(_guncelSiraTuru, document.querySelector("#siraTabBar .sekme-btn.aktif"));
};

window.siraKaydiniSil = async (siraId, ogretmenAd) => {
  if (!await sor("Sira Kaydini Sil", `"${ogretmenAd}" adli ogretmenin sira kaydi silinecek. Bu ogretmen bir sonraki gorevde yeniden listeye girer.`, "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "ogretmen_sirasi", siraId));
  siraTabGoster(_guncelSiraTuru, document.querySelector("#siraTabBar .sekme-btn.aktif"));
};

// ── İSTATİSTİK ──
async function _gorevIstatistikYukle() {
  const container = document.getElementById("gorevIstatistikIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(collection(db, "gorevler"));
  const gorevler = [];
  snap.forEach((d) => gorevler.push({ id: d.id, ...d.data() }));
  if (!gorevler.length) { container.innerHTML = '<div class="bos-mesaj">Henuz gorev yok.</div>'; return; }

  const ogretmenStat = {};
  state.ogretmenler.forEach((o) => { ogretmenStat[o.id] = { ad: o.ad, brans: o.brans, toplam: 0, tamamlandi: 0, tamamlanmadi: 0, acik: 0 }; });
  gorevler.forEach((g) => {
    (g.atanan_ids || []).forEach((id) => {
      if (!ogretmenStat[id]) ogretmenStat[id] = { ad: "?", brans: "?", toplam: 0, tamamlandi: 0, tamamlanmadi: 0, acik: 0 };
      ogretmenStat[id].toplam++;
      if (g.durum === "tamamlandi") ogretmenStat[id].tamamlandi++;
      else if (g.durum === "tamamlanmadi") ogretmenStat[id].tamamlanmadi++;
      else if (g.durum === "acik") ogretmenStat[id].acik++;
    });
  });
  const sirali = Object.values(ogretmenStat).filter((o) => o.toplam > 0).sort((a, b) => b.toplam - a.toplam);
  const toplam = gorevler.length;
  const tamamlandi = gorevler.filter((g) => g.durum === "tamamlandi").length;
  const tamamlanmadi = gorevler.filter((g) => g.durum === "tamamlanmadi").length;
  const acik = gorevler.filter((g) => g.durum === "acik").length;

  container.innerHTML = `
    <div class="stat-grid">
      <div class="stat-kart"><div class="stat-sayi">${toplam}</div><div class="stat-etiket">Toplam Gorev</div></div>
      <div class="stat-kart"><div class="stat-sayi" style="color:var(--yesil)">${tamamlandi}</div><div class="stat-etiket">Tamamlandi</div></div>
      <div class="stat-kart"><div class="stat-sayi" style="color:var(--kirmizi)">${tamamlanmadi}</div><div class="stat-etiket">Tamamlanmadi</div></div>
      <div class="stat-kart"><div class="stat-sayi" style="color:var(--mavi)">${acik}</div><div class="stat-etiket">Acik</div></div>
    </div>
    <div class="kart">
      <div class="kart-baslik">Ogretmen Bazinda Gorev Dagilimi</div>
      <table><thead><tr><th>Ogretmen</th><th>Brans</th><th>Toplam</th><th>Tamamlandi</th><th>Tamamlanmadi</th><th>Acik</th></tr></thead><tbody>
        ${sirali.map((o) => `<tr><td><strong>${esc(o.ad)}</strong></td><td>${esc(o.brans)}</td><td><strong>${o.toplam}</strong></td><td style="color:var(--yesil)">${o.tamamlandi}</td><td style="color:var(--kirmizi)">${o.tamamlanmadi}</td><td>${o.acik}</td></tr>`).join("")}
      </tbody></table>
    </div>`;
}

// ── TAKVİM KİLİDİ ──
window.tarihKilitle = async () => {
  const tarih = document.getElementById("kilitTarih").value;
  const neden = document.getElementById("kilitNeden").value.trim();
  if (!tarih) { mesajGoster("kilitMesaj", "Tarih secin.", "hata"); return; }
  const kontrol = await getDocs(query(collection(db, "takvim_kilidi"), where("tarih", "==", tarih)));
  if (!kontrol.empty) { mesajGoster("kilitMesaj", "Bu tarih zaten kapali.", "hata"); return; }
  await addDoc(collection(db, "takvim_kilidi"), { tarih, neden, olusturan: state.kullanici?.ad || "", olusturulma: bugun });
  mesajGoster("kilitMesaj", "Tarih kapatildi.", "basari");
  document.getElementById("kilitNeden").value = "";
  _kilitliGunleriYukle();
};

async function _kilitliGunleriYukle() {
  const snap = await getDocs(collection(db, "takvim_kilidi"));
  const container = document.getElementById("kilitListesi");
  if (snap.empty) { container.innerHTML = '<div class="bos-mesaj">Kapali gun yok.</div>'; return; }
  let gunler2 = [];
  snap.forEach((d) => gunler2.push({ id: d.id, ...d.data() }));
  gunler2.sort((a, b) => b.tarih.localeCompare(a.tarih));
  let html = "<table><thead><tr><th>Tarih</th><th>Neden</th><th>Ekleyen</th><th></th></tr></thead><tbody>";
  gunler2.forEach((g) => {
    html += `<tr><td><strong>${esc(g.tarih)}</strong></td><td>${esc(g.neden || "—")}</td><td>${esc(g.olusturan || "—")}</td><td><button class="btn btn-kirmizi btn-sm" onclick="kilitSil('${g.id}')">Sil</button></td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

window.kilitSil = async (id) => {
  if (!await sor("Kilidi Kaldir", "Bu gunun kilidini kaldirmak istediginizden emin misiniz?", "Kaldir", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "takvim_kilidi", id));
  _kilitliGunleriYukle();
};

// ── GÖREV RAPORLARI SEKMESİ ──
async function _gorevRaporlariYukle() {
  const container = document.getElementById("gorevRaporlariIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  try {
  const [gorevSnap, siraSnap, raporSnap] = await Promise.all([
    getDocs(collection(db, "gorevler")),
    getDocs(collection(db, "ogretmen_sirasi")),
    getDocs(collection(db, "ogretmen_rapor")),
  ]);

  const gorevler = [];
  gorevSnap.forEach((d) => gorevler.push({ id: d.id, ...d.data() }));
  const siralar = [];
  siraSnap.forEach((d) => siralar.push({ id: d.id, ...d.data() }));
  const raporlar = [];
  raporSnap.forEach((d) => raporlar.push({ id: d.id, ...d.data() }));

  // Öğretmen bazında istatistik
  const ogretmenStat = {};
  state.ogretmenler.forEach((o) => {
    ogretmenStat[o.id] = { ad: o.ad, brans: bransNormalize(o.brans) || "—", toplam: 0, acik: 0, tamamlandi: 0, tamamlanmadi: 0 };
  });
  gorevler.forEach((g) => {
    (g.atanan_ids || []).forEach((id) => {
      if (!ogretmenStat[id]) ogretmenStat[id] = { ad: "?", brans: "?", toplam: 0, acik: 0, tamamlandi: 0, tamamlanmadi: 0 };
      ogretmenStat[id].toplam++;
      if (g.durum === "acik") ogretmenStat[id].acik++;
      else if (g.durum === "tamamlandi") ogretmenStat[id].tamamlandi++;
      else if (g.durum === "tamamlanmadi") ogretmenStat[id].tamamlanmadi++;
    });
  });

  // Branş bazında grupla
  const bransGrubu = {};
  Object.values(ogretmenStat).forEach((o) => {
    if (!bransGrubu[o.brans]) bransGrubu[o.brans] = [];
    bransGrubu[o.brans].push(o);
  });

  // Sıra bilgisi: her sıra türü için siradaki öğretmeni bul
  const siraTablosu = {};
  const siraKeys = [...new Set(siralar.map((s) => s.sira_turu))].sort();
  const raporluIds = new Set(
    raporlar.filter((r) => r.baslangic_tarihi <= bugun && r.bitis_tarihi >= bugun).map((r) => r.ogretmen_id)
  );
  siraKeys.forEach((tur) => {
    const turSiralar = siralar.filter((s) => s.sira_turu === tur).sort((a, b) => (a.son_atama || "").localeCompare(b.son_atama || ""));
    const siradaki = turSiralar.find((s) => !(s.cooldown_bitis >= bugun) && !raporluIds.has(s.ogretmen_id));
    siraTablosu[tur] = { liste: turSiralar, siradaki: siradaki?.ogretmen_ad || "—" };
  });

  // Aktif raporlar
  const aktifRaporlar = raporlar.filter((r) => r.bitis_tarihi >= bugun).sort((a, b) => a.baslangic_tarihi.localeCompare(b.baslangic_tarihi));

  let html = "";

  // Aktif raporlar tablosu
  html += `<div class="kart"><div class="kart-baslik">🏥 Aktif ve Yaklaşan Raporlar</div>`;
  if (aktifRaporlar.length) {
    html += `<table><thead><tr><th>Öğretmen</th><th>Baslangic</th><th>Bitis</th><th>Aciklama</th><th></th></tr></thead><tbody>`;
    aktifRaporlar.forEach((r) => {
      const aktif = r.baslangic_tarihi <= bugun;
      html += `<tr>
        <td><strong>${esc(r.ogretmen_ad)}</strong></td>
        <td>${esc(r.baslangic_tarihi)}</td>
        <td>${esc(r.bitis_tarihi)}</td>
        <td>${esc(r.aciklama || "—")}</td>
        <td><button class="btn btn-kirmizi btn-sm" onclick="raporSil('${r.id}')">Sil</button></td>
      </tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="bos-mesaj">Aktif rapor yok.</div>`;
  }
  html += `</div>`;

  // Branş sıra durumu
  html += `<div class="kart"><div class="kart-baslik">📊 Branş Sıra Durumu</div>`;
  if (siraKeys.length) {
    html += `<table><thead><tr><th>Tur</th><th>Siradaki</th><th>Toplam Kayit</th></tr></thead><tbody>`;
    siraKeys.forEach((tur) => {
      const bilgi = siraTablosu[tur];
      html += `<tr><td><strong>${esc(tur === "genel" ? "Genel" : tur.replace("brans_", ""))}</strong></td><td><span class="rozet rozet-mavi">${esc(bilgi.siradaki)}</span></td><td>${bilgi.liste.length}</td></tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="bos-mesaj">Henuz sira kaydi yok.</div>`;
  }
  html += `</div>`;

  // Öğretmen bazında görev tablosu
  html += `<div class="kart"><div class="kart-baslik">👤 Öğretmen Bazında Görev Dağılımı</div>`;
  const sorted = Object.values(ogretmenStat).sort((a, b) => b.toplam - a.toplam || a.ad.localeCompare(b.ad, "tr"));
  if (sorted.some((o) => o.toplam > 0)) {
    html += `<table><thead><tr><th>Ogretmen</th><th>Brans</th><th>Toplam</th><th>Acik</th><th>Tamamlandi</th><th>Tamamlanmadi</th></tr></thead><tbody>`;
    sorted.forEach((o) => {
      html += `<tr><td><strong>${esc(o.ad)}</strong></td><td>${esc(o.brans)}</td><td><strong>${o.toplam}</strong></td><td>${o.acik}</td><td style="color:var(--yesil)">${o.tamamlandi}</td><td style="color:var(--kirmizi)">${o.tamamlanmadi}</td></tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="bos-mesaj">Henuz gorev verisi yok.</div>`;
  }
  html += `</div>`;

  container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="bos-mesaj" style="color:#ea4335;">Hata: ${esc(err.message)}</div>`;
  }
}

window.raporSil = async (raporId) => {
  if (!await sor("Raporu Sil", "Bu rapor kaydı silinecek.", "Sil", "btn-kirmizi")) return;
  await deleteDoc(doc(db, "ogretmen_rapor", raporId));
  _gorevRaporlariYukle();
};
