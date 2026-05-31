// ── RAPORLAR MODÜLÜ ──
// portal.html'den ayrilmis bagimsiz JS dosyasi.
// Calisabilmek icin window.__portal nesnesine ihtiyac duyar.
// Bu nesne portal.html'deki <script type="module"> tarafindan set edilir.

window.raporSayfasiBaslat = function () {
  const { bugun } = window.__portal;
  if (!document.getElementById("gunlukTarih").value)
    document.getElementById("gunlukTarih").value = bugun;
  if (!document.getElementById("gecBaslangic").value)
    document.getElementById("gecBaslangic").value = bugun;
  if (!document.getElementById("gecBitis").value)
    document.getElementById("gecBitis").value = bugun;
  const ayBas = new Date();
  ayBas.setDate(1);
  if (!document.getElementById("istatBaslangic").value)
    document.getElementById("istatBaslangic").value = ayBas
      .toISOString()
      .split("T")[0];
  if (!document.getElementById("istatBitis").value)
    document.getElementById("istatBitis").value = bugun;
};

window.raporSekme = function (id, el) {
  document
    .querySelectorAll("#sayfa-raporlar .sekme-icerik")
    .forEach((s) => s.classList.remove("aktif"));
  document
    .querySelectorAll("#sayfa-raporlar .sekme-btn")
    .forEach((b) => b.classList.remove("aktif"));
  document.getElementById("rsekme-" + id).classList.add("aktif");
  el.classList.add("aktif");
  if (id === "ogretmendevam") {
    const bugun = new Date();
    const ayBas = new Date(bugun.getFullYear(), bugun.getMonth(), 1)
      .toISOString()
      .split("T")[0];
    const ayBit = bugun.toISOString().split("T")[0];
    const b = document.getElementById("devamBaslangic");
    const e = document.getElementById("devamBitis");
    if (b && !b.value) b.value = ayBas;
    if (e && !e.value) e.value = ayBit;
    window.ogretmenDevamRaporu();
  } else if (id === "dyk") {
    const bugun = new Date();
    const ayBas = new Date(bugun.getFullYear(), bugun.getMonth(), 1)
      .toISOString()
      .split("T")[0];
    const ayBit = bugun.toISOString().split("T")[0];
    const b = document.getElementById("dykRapBaslangic");
    const e = document.getElementById("dykRapBitis");
    if (b && !b.value) b.value = ayBas;
    if (e && !e.value) e.value = ayBit;
  }
};

window.gunlukRaporGetir = async function () {
  const { db, getDocs, collection, query, where } = window.__portal;
  const tarih = document.getElementById("gunlukTarih").value;
  const container = document.getElementById("gunlukRaporIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const sinifSnap = await getDocs(collection(db, "classes"));
  let siniflar = [];
  sinifSnap.forEach((d) => siniflar.push(d.data()));
  siniflar.sort((a, b) =>
    a.grade !== b.grade
      ? a.grade - b.grade
      : a.class_name.localeCompare(b.class_name),
  );

  // O günün haftanın günü adını hesapla (schedule'daki day alanıyla eşleşsin)
  const _GUNLER_TR = ["pazar", "pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi"];
  const gunAdi = _GUNLER_TR[new Date(tarih + "T12:00:00").getDay()];

  // O gün için programdaki ders sayısını sınıf bazında çek
  const schedSnap = await getDocs(query(collection(db, "schedule"), where("day", "==", gunAdi)));
  const sinifProgramDersSayisi = {};
  schedSnap.forEach((d) => {
    const v = d.data();
    if (!sinifProgramDersSayisi[v.class_id]) sinifProgramDersSayisi[v.class_id] = new Set();
    sinifProgramDersSayisi[v.class_id].add(v.lesson_number);
  });

  const attSnap = await getDocs(
    query(collection(db, "attendance"), where("date", "==", tarih)),
  );
  if (attSnap.empty) {
    container.innerHTML =
      '<div class="bos-mesaj">Bu tarihte yoklama kaydi yok.</div>';
    return;
  }

  const ogrenciDersler = {};
  const sinifDersler = {};

  attSnap.forEach((d) => {
    const data = d.data();
    const classId = data.class_id;
    if (!sinifDersler[classId]) sinifDersler[classId] = 0;
    sinifDersler[classId]++;
    (data.absent_students || []).forEach((no) => {
      const key = classId + "|" + no;
      if (!ogrenciDersler[key])
        ogrenciDersler[key] = { class_id: classId, no, yok: 0 };
      ogrenciDersler[key].yok++;
    });
  });

  const sinifDevamsiz = {};
  Object.values(ogrenciDersler).forEach((ogr) => {
    // Programdaki toplam ders sayısını kullan; program yoksa kaydedilen ders sayısını kullan
    const toplamDers = sinifProgramDersSayisi[ogr.class_id]?.size || sinifDersler[ogr.class_id] || 1;
    if (!sinifDevamsiz[ogr.class_id])
      sinifDevamsiz[ogr.class_id] = { tamGun: [], yarimGun: [] };
    if (ogr.yok >= toplamDers) {
      sinifDevamsiz[ogr.class_id].tamGun.push(ogr.no);
    } else {
      sinifDevamsiz[ogr.class_id].yarimGun.push(ogr.no);
    }
  });

  const tarihStr = new Date(tarih + "T12:00:00").toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "long",
  });
  let html = `<div class="kart"><div style="text-align:center;margin-bottom:16px;"><div style="font-size:16px;font-weight:800;">AHMET YENİCE ORTAOKULU</div><div style="font-size:13px;color:var(--text2);margin-top:4px;">Gunluk Devamsizlik Raporu — ${tarihStr}</div></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">`;
  siniflar.forEach((s) => {
    const v = sinifDevamsiz[s.class_name] || { tamGun: [], yarimGun: [] };
    html += `<div class="rapor-sinif"><div class="rapor-sinif-baslik">${s.class_name}</div><div class="rapor-sinif-icerik"><div class="rapor-tam"><div class="rapor-alt-baslik">Tam Gun</div><div class="rapor-ogrenciler">${v.tamGun.length ? v.tamGun.join(", ") : '<span class="rapor-bos">Yok</span>'}</div></div><div class="rapor-yarim"><div class="rapor-alt-baslik">Yarim Gun</div><div class="rapor-ogrenciler">${v.yarimGun.length ? v.yarimGun.join(", ") : '<span class="rapor-bos">Yok</span>'}</div></div></div></div>`;
  });
  html += "</div></div>";
  container.innerHTML = html;
};

window.ogretmenDevamRaporu = async function () {
  const { db, getDocs, collection, query, where } = window.__portal;
  const bas = document.getElementById("devamBaslangic").value;
  const bit = document.getElementById("devamBitis").value;
  const container = document.getElementById("devamRaporIcerik");
  if (!bas || !bit) {
    container.innerHTML = '<div class="bos-mesaj">Tarih araligi secin.</div>';
    return;
  }
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const snap = await getDocs(
    query(
      collection(db, "ogretmen_devam"),
      where("tarih", ">=", bas),
      where("tarih", "<=", bit),
    ),
  );

  if (snap.empty) {
    container.innerHTML =
      '<div class="bos-mesaj">Bu tarih araliginda kayit yok.</div>';
    return;
  }

  const ogretmenStat = {};
  snap.forEach((d) => {
    const veri = d.data();
    const id = veri.ogretmen_id;
    if (!ogretmenStat[id])
      ogretmenStat[id] = {
        ad: veri.ogretmen_ad,
        geldi: 0,
        gec: 0,
        gelmedi: 0,
        gecSaatler: [],
      };
    if (veri.durum === "geldi") ogretmenStat[id].geldi++;
    else if (veri.durum === "gec") {
      ogretmenStat[id].gec++;
      if (veri.gec_saat)
        ogretmenStat[id].gecSaatler.push(veri.tarih + " " + veri.gec_saat);
    } else if (veri.durum === "gelmedi") ogretmenStat[id].gelmedi++;
  });

  const sirali = Object.values(ogretmenStat).sort((a, b) =>
    a.ad.localeCompare(b.ad, "tr"),
  );
  const toplamGeldi = sirali.reduce((t, o) => t + o.geldi, 0);
  const toplamGec = sirali.reduce((t, o) => t + o.gec, 0);
  const toplamGelmedi = sirali.reduce((t, o) => t + o.gelmedi, 0);

  let html =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">';
  html +=
    '<div class="stat-kart"><div class="stat-sayi" style="color:var(--yesil)">' +
    toplamGeldi +
    '</div><div class="stat-etiket">Toplam Geldi</div></div>';
  html +=
    '<div class="stat-kart"><div class="stat-sayi" style="color:var(--turuncu)">' +
    toplamGec +
    '</div><div class="stat-etiket">Toplam Gec</div></div>';
  html +=
    '<div class="stat-kart"><div class="stat-sayi" style="color:var(--kirmizi)">' +
    toplamGelmedi +
    '</div><div class="stat-etiket">Toplam Gelmedi</div></div>';
  html += "</div>";
  html += '<div class="kart"><div class="kart-baslik">Ogretmen Detay</div>';
  html +=
    '<table><thead><tr><th>Ogretmen</th><th style="color:var(--yesil)">Geldi</th><th style="color:var(--turuncu)">Gec</th><th style="color:var(--kirmizi)">Gelmedi</th><th>Toplam Kayit</th></tr></thead><tbody>';

  sirali.forEach((o) => {
    const toplam = o.geldi + o.gec + o.gelmedi;
    const gecStr = o.gecSaatler.length
      ? '<br><small style="color:var(--text2);">' +
        o.gecSaatler.slice(0, 3).join(", ") +
        (o.gecSaatler.length > 3 ? "..." : "") +
        "</small>"
      : "";
    html +=
      "<tr>" +
      "<td><strong>" +
      o.ad +
      "</strong></td>" +
      '<td style="color:var(--yesil);font-weight:700;">' +
      o.geldi +
      "</td>" +
      '<td style="color:var(--turuncu);font-weight:700;">' +
      o.gec +
      gecStr +
      "</td>" +
      '<td style="color:var(--kirmizi);font-weight:700;">' +
      o.gelmedi +
      "</td>" +
      "<td>" +
      toplam +
      "</td>" +
      "</tr>";
  });

  html += "</tbody></table></div>";
  container.innerHTML = html;
};

window.gecRaporGetir = async function () {
  const { db, getDocs, collection, query, where, getTumOgretmenler } =
    window.__portal;
  const tumOgretmenler = getTumOgretmenler();
  const bas = document.getElementById("gecBaslangic").value;
  const bit = document.getElementById("gecBitis").value;
  const container = document.getElementById("gecRaporIcerik");
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';
  const snap = await getDocs(
    query(
      collection(db, "late_entries"),
      where("date", ">=", bas),
      where("date", "<=", bit),
    ),
  );
  if (snap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Gec giris kaydi yok.</div>';
    return;
  }
  const ogMap = {};
  tumOgretmenler.forEach((o) => (ogMap[o.id] = o));
  const benzersiz = new Set();
  snap.forEach((d) => benzersiz.add(d.data().teacher_id));
  let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;"><div class="stat-kart"><div class="stat-sayi" style="color:var(--turuncu)">${snap.size}</div><div class="stat-etiket">Toplam Gec Giris</div></div><div class="stat-kart"><div class="stat-sayi">${benzersiz.size}</div><div class="stat-etiket">Farkli Ogretmen</div></div></div><div class="kart"><table><thead><tr><th>Ogretmen</th><th>Tarih</th><th>Sinif</th><th>Ders</th></tr></thead><tbody>`;
  snap.docs
    .sort((a, b) => a.data().date.localeCompare(b.data().date))
    .forEach((d) => {
      const data = d.data();
      html += `<tr><td>${ogMap[data.teacher_id]?.ad || "-"}</td><td>${data.date}</td><td>${data.class_id}</td><td>${data.lesson_number}. Ders</td></tr>`;
    });
  html += "</tbody></table></div>";
  container.innerHTML = html;
};

window.dykRaporGetir = async function () {
  const { db, getDocs, collection, query, where } = window.__portal;
  const bas = document.getElementById("dykRapBaslangic").value;
  const bit = document.getElementById("dykRapBitis").value;
  const container = document.getElementById("dykRaporIcerik");
  if (!bas || !bit) {
    container.innerHTML = '<div class="bos-mesaj">Tarih araligi secin.</div>';
    return;
  }
  container.innerHTML = '<div class="yukleniyor">Yukleniyor...</div>';

  const [attSnap, kursSnap, ogSnap] = await Promise.all([
    getDocs(query(collection(db, "dyk_attendance"), where("date", ">=", bas), where("date", "<=", bit))),
    getDocs(collection(db, "dyk_courses")),
    getDocs(collection(db, "teachers")),
  ]);

  if (attSnap.empty) {
    container.innerHTML = '<div class="bos-mesaj">Bu tarih araliginda DYK devamsizlik kaydi yok.</div>';
    return;
  }

  const kurslar = {};
  kursSnap.forEach((d) => (kurslar[d.id] = { id: d.id, ...d.data() }));
  const ogretmenler = {};
  ogSnap.forEach((d) => (ogretmenler[d.id] = d.data()));

  // Kurs bazında devamsızlık sayısını topla
  const kursStat = {};
  let toplamDevamsizlik = 0;
  attSnap.forEach((d) => {
    const v = d.data();
    const kursBilgi = kurslar[v.course_id] || {};
    if (!kursStat[v.course_id])
      kursStat[v.course_id] = {
        ad: kursBilgi.course_name || v.course_id,
        sinif: kursBilgi.class_id || "",
        ogretmen: ogretmenler[kursBilgi.teacher_id]?.ad || "",
        gunler: [],
        ogrenciSayim: {},
      };
    const yoklar = v.absent_students || [];
    if (yoklar.length) {
      kursStat[v.course_id].gunler.push({ tarih: v.date, yoklar });
      yoklar.forEach((no) => {
        kursStat[v.course_id].ogrenciSayim[no] =
          (kursStat[v.course_id].ogrenciSayim[no] || 0) + 1;
        toplamDevamsizlik++;
      });
    }
  });

  const sirali = Object.values(kursStat).sort((a, b) =>
    (a.sinif + a.ad).localeCompare(b.sinif + b.ad, "tr"),
  );

  let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
    <div class="stat-kart"><div class="stat-sayi">${toplamDevamsizlik}</div><div class="stat-etiket">Toplam Devamsizlik</div></div>
    <div class="stat-kart"><div class="stat-sayi" style="color:var(--mavi)">${sirali.length}</div><div class="stat-etiket">Kurs Sayisi</div></div>
  </div>
  <div class="kart"><div class="kart-baslik">Kurs Bazinda DYK Devamsizliklari</div>`;

  if (!sirali.length) {
    html += '<div class="bos-mesaj">Devamsizlik kaydi bulunamadi.</div>';
  } else {
    html += '<table><thead><tr><th>Sinif</th><th>Kurs</th><th>Ogretmen</th><th>Devamsiz Gun</th><th>Toplam Devamsizlik</th></tr></thead><tbody>';
    sirali.forEach((k) => {
      const toplamOgrenci = Object.keys(k.ogrenciSayim).length;
      const toplamKayit = Object.values(k.ogrenciSayim).reduce((t, v) => t + v, 0);
      const enCokYoklanan = Object.entries(k.ogrenciSayim)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([no, sayi]) => `${no} (${sayi}x)`)
        .join(", ");
      html += `<tr>
        <td><strong>${k.sinif}</strong></td>
        <td>${k.ad}</td>
        <td>${k.ogretmen || "—"}</td>
        <td>${k.gunler.length}</td>
        <td><strong style="color:var(--kirmizi)">${toplamKayit}</strong>
          ${toplamOgrenci > 0 ? `<br><small style="color:var(--text2)">${toplamOgrenci} ogrenci — ${enCokYoklanan}</small>` : ""}
        </td>
      </tr>`;
    });
    html += '</tbody></table>';
  }

  html += '</div>';
  container.innerHTML = html;
};

window.istatistikGetir = async function () {
  const { db, getDocs, collection, query, where } = window.__portal;
  const bas = document.getElementById("istatBaslangic").value;
  const bit = document.getElementById("istatBitis").value;
  const container = document.getElementById("istatistikIcerik");
  container.innerHTML =
    '<div class="yukleniyor">Veriler hesaplaniyor...</div>';

  const attSnap = await getDocs(
    query(
      collection(db, "attendance"),
      where("date", ">=", bas),
      where("date", "<=", bit),
    ),
  );
  if (attSnap.empty) {
    container.innerHTML =
      '<div class="bos-mesaj">Bu tarih araliginda veri yok.</div>';
    return;
  }

  const sinifSnap = await getDocs(collection(db, "classes"));
  const siniflar = {};
  sinifSnap.forEach((d) => (siniflar[d.data().class_name] = d.data()));

  const gunSinifDersler = {};
  const gunSinifYok = {};
  const gunlukToplam = {};

  attSnap.forEach((d) => {
    const data = d.data();
    const key = data.date + "|" + data.class_id;
    if (!gunSinifDersler[key]) gunSinifDersler[key] = 0;
    gunSinifDersler[key]++;
    (data.absent_students || []).forEach((no) => {
      const ogrKey = data.date + "|" + data.class_id + "|" + no;
      if (!gunSinifYok[ogrKey])
        gunSinifYok[ogrKey] = { date: data.date, class_id: data.class_id, no, yok: 0 };
      gunSinifYok[ogrKey].yok++;
    });
  });

  const sd = {};
  const kd = { 5: 0, 6: 0, 7: 0, 8: 0 };
  const gd = {};
  let tamToplam = 0, yarToplam = 0;

  Object.values(gunSinifYok).forEach((ogr) => {
    const dersKey = ogr.date + "|" + ogr.class_id;
    const toplamDers = gunSinifDersler[dersKey] || 1;
    const tamGun = ogr.yok >= toplamDers;
    const kademe = siniflar[ogr.class_id]?.grade;
    if (!sd[ogr.class_id]) sd[ogr.class_id] = { tam: 0, yar: 0 };
    if (!gd[ogr.date]) gd[ogr.date] = 0;
    if (tamGun) {
      sd[ogr.class_id].tam++;
      if (kademe) kd[kademe]++;
      tamToplam++;
      gd[ogr.date]++;
    } else {
      sd[ogr.class_id].yar++;
      if (kademe) kd[kademe]++;
      yarToplam++;
      gd[ogr.date]++;
    }
  });

  const sirali = Object.entries(sd)
    .map(([s, v]) => ({ s, t: v.tam + v.yar, tam: v.tam, yar: v.yar }))
    .sort((a, b) => b.t - a.t);

  container.innerHTML = `<div class="stat-ozet">
  <div class="stat-kart"><div class="stat-sayi">${tamToplam + yarToplam}</div><div class="stat-etiket">Toplam Devamsizlik</div></div>
  <div class="stat-kart"><div class="stat-sayi" style="color:var(--kirmizi)">${tamToplam}</div><div class="stat-etiket">Tam Gun</div></div>
  <div class="stat-kart"><div class="stat-sayi" style="color:var(--text2)">${yarToplam}</div><div class="stat-etiket">Yarim Gun</div></div>
  <div class="stat-kart"><div class="stat-sayi" style="color:var(--yesil)">${sirali[0]?.s || "—"}</div><div class="stat-etiket">En Cok Devamsiz</div></div>
</div>
<div class="grafik-grid">
  <div class="grafik-kart"><h4>Sinif Bazinda</h4><canvas id="sinifGrafik"></canvas></div>
  <div class="grafik-kart"><h4>Kademe</h4><canvas id="kademeGrafik"></canvas></div>
</div>
<div class="grafik-kart" style="margin-bottom:20px;"><h4>Gunluk Trend</h4><canvas id="trendGrafik"></canvas></div>
<div class="kart"><div class="kart-baslik">Sinif Detay Tablosu</div>
  <table><thead><tr><th>Sinif</th><th>Tam Gun</th><th>Yarim Gun</th><th>Toplam</th></tr></thead><tbody>
    ${sirali.map((s) => `<tr><td><strong>${s.s}</strong></td><td style="color:var(--kirmizi)">${s.tam}</td><td style="color:var(--text2)">${s.yar}</td><td><strong>${s.t}</strong></td></tr>`).join("")}
  </tbody></table>
</div>`;

  const top10 = sirali.slice(0, 10);
  new Chart(document.getElementById("sinifGrafik"), {
    type: "bar",
    data: {
      labels: top10.map((s) => s.s),
      datasets: [
        {
          label: "Tam Gun",
          data: top10.map((s) => s.tam),
          backgroundColor: "#ea433580",
          borderColor: "#ea4335",
          borderWidth: 1,
        },
        {
          label: "Yarim Gun",
          data: top10.map((s) => s.yar),
          backgroundColor: "#9e9e9e80",
          borderColor: "#9e9e9e",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "top" } },
      scales: { y: { beginAtZero: true } },
    },
  });
  new Chart(document.getElementById("kademeGrafik"), {
    type: "doughnut",
    data: {
      labels: ["5. Sinif", "6. Sinif", "7. Sinif", "8. Sinif"],
      datasets: [
        {
          data: [kd[5], kd[6], kd[7], kd[8]],
          backgroundColor: ["#1a73e8", "#34a853", "#fbbc04", "#ea4335"],
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
    },
  });
  const gg = Object.keys(gd).sort();
  new Chart(document.getElementById("trendGrafik"), {
    type: "line",
    data: {
      labels: gg.map((g) =>
        new Date(g + "T12:00:00").toLocaleDateString("tr-TR", {
          day: "numeric",
          month: "short",
        }),
      ),
      datasets: [
        {
          label: "Gunluk Toplam",
          data: gg.map((g) => gd[g]),
          borderColor: "#1a73e8",
          backgroundColor: "#1a73e820",
          borderWidth: 2,
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "top" } },
      scales: { y: { beginAtZero: true } },
    },
  });
};
