// ── ORTAK EXCEL (.xlsx) YARDIMCILARI ──
// SheetJS sadece ilk kullanimda yuklenir (624 KB; CSP: cdnjs izinli).
// Kullananlar: portal-para.js (Para Toplama), portal-vekil-ders.js (Vekil Ders Kayitlari).

// Nokta kacisli: SheetJS bicimlendiricisi "dd.mm.yyyy"deki noktayi saniye
// sanip hata veriyor; Excel'de gorunum ayni (06.10.2026).
export const TARIH_BICIMI = "dd\\.mm\\.yyyy";
export const TARIH_SAAT_BICIMI = "dd\\.mm\\.yyyy hh:mm";

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

export function xlsxYukle() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = XLSX_URL;
    sc.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("Excel kütüphanesi yüklenemedi.")));
    sc.onerror = () => reject(new Error("Excel kütüphanesi yüklenemedi (internet bağlantısını kontrol edin)."));
    document.head.appendChild(sc);
  });
}

// satirlar: ilk satir baslik. genislikler: sutun genislikleri (karakter).
// tutarSutunlari: TL bicimi verilecek sutun indeksleri; tarihSutunlari: Date
// hucrelerine gg.aa.yyyy bicimi verilecek sutun indeksleri.
export function sayfaOlustur(XLSX, satirlar, genislikler, tutarSutunlari = [], tarihSutunlari = []) {
  const ws = XLSX.utils.aoa_to_sheet(satirlar, { cellDates: true });
  ws["!cols"] = genislikler.map((w) => ({ wch: w }));
  const aralik = XLSX.utils.decode_range(ws["!ref"]);
  for (let r = 1; r <= aralik.e.r; r++) {
    tutarSutunlari.forEach((c) => {
      const h = ws[XLSX.utils.encode_cell({ r, c })];
      if (h && typeof h.v === "number") h.z = '#,##0.00 "₺"';
    });
    tarihSutunlari.forEach((c) => {
      const h = ws[XLSX.utils.encode_cell({ r, c })];
      if (h && h.t === "d") h.z = TARIH_BICIMI;
    });
  }
  return ws;
}

// "2026-10-07" -> Date (yerel gun, saat 12:00; Excel'de gun kaymasin)
export function isoTarih(t) {
  const [y, m, d] = String(t || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d, 12) : String(t || "");
}

export function dosyaAdi(metin) {
  return String(metin).replace(/[\\/:*?"<>|]/g, "-").trim();
}
