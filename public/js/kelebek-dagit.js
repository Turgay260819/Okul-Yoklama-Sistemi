// ── KELEBEK SINAV DAĞITIMI (saf fonksiyonlar; DOM/Firestore yok, test edilebilir) ──
// Amac: ayni subeden ogrenciler mumkun oldugunca ayni salonda ve (sira no
// aciksa) yan yana olmasin.
//  1) Salon yukleri: N ogrenci salonlara kapasiteyle orantili (en buyuk kalan).
//  2) Sube kotalari: en kalabalik subeden baslayarak her sube, salonlarin kalan
//     yerine orantili dagitilir -> her sube tum salonlara esit yayilir.
//  3) Salon ici sira (sira no aciksa): her siraya, kalani en cok olan ve bir
//     onceki siradakiyle ayni sube olmayan (mumkunse ayni kademe de olmayan)
//     subeden ogrenci konur. Sira n ile n+1 komsu sayilir.

// Tohumlu rastgele (ayni tohum = ayni dagilim; "Yeniden dagit" tohumu degistirir).
function rastgele(tohum) {
  let a = (Number(tohum) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function karistir(dizi, rnd) {
  const d = dizi.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function kademeAl(sinif) {
  const m = String(sinif || "").match(/^\d+/);
  return m ? m[0] : String(sinif || "");
}

// Toplami `toplam` olan tamsayi paylar; agirliklarla orantili, ust sinirlar dahilinde.
function orantiliPaylas(toplam, agirliklar, ustSinirlar) {
  const n = agirliklar.length;
  const pay = new Array(n).fill(0);
  if (!toplam) return pay;
  const agirlikToplam = agirliklar.reduce((a, b) => a + b, 0);
  if (!agirlikToplam) return pay;
  const ham = agirliklar.map((w) => (toplam * w) / agirlikToplam);
  for (let i = 0; i < n; i++) pay[i] = Math.min(Math.floor(ham[i]), ustSinirlar[i]);
  let kalan = toplam - pay.reduce((a, b) => a + b, 0);
  // Once kesir payi buyuk olanlara, sonra en cok yeri kalanlara birer birer.
  const sira = [...Array(n).keys()].sort((a, b) => (ham[b] - Math.floor(ham[b])) - (ham[a] - Math.floor(ham[a])));
  for (const i of sira) {
    if (!kalan) break;
    if (pay[i] < ustSinirlar[i]) { pay[i]++; kalan--; }
  }
  while (kalan > 0) {
    let enIyi = -1;
    for (let i = 0; i < n; i++) {
      if (pay[i] < ustSinirlar[i] && (enIyi < 0 || ustSinirlar[i] - pay[i] > ustSinirlar[enIyi] - pay[enIyi])) enIyi = i;
    }
    if (enIyi < 0) break;
    pay[enIyi]++; kalan--;
  }
  return pay;
}

// ogrenciler: [{ ogrenci_id, no, ad, sinif }]; salonlar: [{ ad, kapasite }]
// Donus: [{ ogrenci_id, no, ad, sinif, salon, sira|null }] (salon sirasi, sonra sira/ad)
export function kelebekDagit(ogrenciler, salonlar, siraNo, tohum = 1) {
  const N = ogrenciler.length;
  const kapasiteler = salonlar.map((s) => Math.max(0, Math.floor(Number(s.kapasite) || 0)));
  const toplamKap = kapasiteler.reduce((a, b) => a + b, 0);
  if (!salonlar.length) throw new Error("En az bir salon ekleyin.");
  if (N > toplamKap) throw new Error(`Salon kapasitesi yetersiz: ${N} öğrenci, ${toplamKap} yer.`);
  const rnd = rastgele(tohum);

  // 1) Salon yukleri
  const yuk = orantiliPaylas(N, kapasiteler, kapasiteler);

  // 2) Sube kotalari
  const subeler = {};
  ogrenciler.forEach((o) => (subeler[o.sinif] ||= []).push(o));
  const subeListesi = Object.entries(subeler)
    .map(([ad, liste]) => ({ ad, liste: karistir(liste, rnd) }))
    .sort((a, b) => b.liste.length - a.liste.length || a.ad.localeCompare(b.ad, "tr"));
  const kalanYer = yuk.slice();
  const salonOgrencileri = salonlar.map(() => []);
  subeListesi.forEach((sube) => {
    const pay = orantiliPaylas(sube.liste.length, kalanYer, kalanYer);
    let k = 0;
    pay.forEach((adet, j) => {
      for (let x = 0; x < adet; x++) salonOgrencileri[j].push(sube.liste[k++]);
      kalanYer[j] -= adet;
    });
  });

  // 3) Salon ici siralama
  const sonuc = [];
  salonOgrencileri.forEach((liste, j) => {
    const salonAd = salonlar[j].ad;
    if (!siraNo) {
      liste.slice().sort((a, b) => String(a.ad).localeCompare(String(b.ad), "tr"))
        .forEach((o) => sonuc.push({ ...o, salon: salonAd, sira: null }));
      return;
    }
    const kovalar = {};
    liste.forEach((o) => (kovalar[o.sinif] ||= []).push(o));
    let onceki = null;
    for (let sira = 1; sira <= liste.length; sira++) {
      const adaylar = Object.keys(kovalar).filter((s) => kovalar[s].length);
      const puan = (s) => {
        let p = kovalar[s].length * 4;
        if (onceki && s === onceki.sinif) p -= 1000;
        else if (onceki && kademeAl(s) === kademeAl(onceki.sinif)) p -= 1;
        return p + rnd() * 0.5;
      };
      adaylar.sort((a, b) => puan(b) - puan(a));
      const o = kovalar[adaylar[0]].pop();
      sonuc.push({ ...o, salon: salonAd, sira });
      onceki = o;
    }
  });
  return sonuc;
}

// Onizleme / kontrol: salon basina sayi, sube dagilimi, en buyuk ayni-sube
// sayisi ve (sira no varsa) yan yana ayni sube sayisi.
export function kelebekIstatistik(dagilim, salonlar) {
  return salonlar.map((s) => {
    const liste = dagilim.filter((d) => d.salon === s.ad);
    const subeler = {};
    liste.forEach((d) => (subeler[d.sinif] = (subeler[d.sinif] || 0) + 1));
    const sirali = liste.filter((d) => d.sira != null).sort((a, b) => a.sira - b.sira);
    let komsuAyni = 0;
    for (let i = 1; i < sirali.length; i++) if (sirali[i].sinif === sirali[i - 1].sinif) komsuAyni++;
    return {
      salon: s.ad, kapasite: s.kapasite, sayi: liste.length, subeler,
      enBuyuk: Math.max(0, ...Object.values(subeler)), komsuAyni,
    };
  });
}
