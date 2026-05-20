const BRANS_MAP = {
  "din kulturu":                  "Din Kültürü",
  "din kültürü ve ahlak bilgisi": "Din Kültürü",
  "ilköğretim matematik":         "Matematik",
  "i̇lköğretim matematik":   "Matematik",
  "rehberlik":                    "Rehber Öğretmen",
};

export function bransNormalize(brans) {
  if (!brans) return brans;
  return BRANS_MAP[brans.trim().toLowerCase()] ?? brans;
}
window.bransNormalize = bransNormalize;

// Escapes user-provided strings before injecting into innerHTML
export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mesajGoster(id, metin, tip) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = metin;
  el.className = "mesaj mesaj-" + tip;
  el.style.display = "block";
  if (tip !== "bilgi") setTimeout(() => (el.style.display = "none"), 4000);
}
window.mesajGoster = mesajGoster;

// Adds `gun` days to a YYYY-MM-DD date string
export function tarihEkle(tarihStr, gun) {
  const d = new Date(tarihStr);
  d.setDate(d.getDate() + gun);
  return d.toISOString().split("T")[0];
}

export function haftaNoBasit(baslangicStr, bugun) {
  if (!baslangicStr) return "?";
  const bas = new Date(baslangicStr + "T12:00:00");
  const bug = new Date(bugun + "T12:00:00");
  return Math.max(1, Math.floor((bug - bas) / (7 * 86400000)) + 1);
}

export function haftaNoHesapla(baslangicStr, hedefStr, tatiller) {
  const bas = new Date(baslangicStr + "T12:00:00");
  const hedef = new Date(hedefStr + "T12:00:00");
  let toplamHafta = Math.max(1, Math.floor((hedef - bas) / (7 * 86400000)) + 1);
  tatiller.forEach((t) => {
    const tBas = new Date(t.baslangic + "T12:00:00");
    if (tBas <= hedef) toplamHafta = Math.max(1, toplamHafta - (t.hafta_sayisi || 0));
  });
  return toplamHafta;
}

// Promise-based confirm dialog using existing gorevOnayModal as a generic modal
export function sor(baslik, aciklama, onayBtnMetin = "Onayla", onayBtnSinif = "btn-mavi") {
  return new Promise((resolve) => {
    const modal = document.getElementById("genel-onay-modal");
    if (!modal) { resolve(window.confirm(aciklama)); return; }
    document.getElementById("gom-baslik").textContent = baslik;
    document.getElementById("gom-aciklama").textContent = aciklama;
    const btn = document.getElementById("gom-onayla");
    btn.textContent = onayBtnMetin;
    btn.className = "btn " + onayBtnSinif;
    modal.classList.add("aktif");

    function kapat(sonuc) {
      modal.classList.remove("aktif");
      document.getElementById("gom-iptal").onclick = null;
      btn.onclick = null;
      resolve(sonuc);
    }
    btn.onclick = () => kapat(true);
    document.getElementById("gom-iptal").onclick = () => kapat(false);
  });
}

// Prompt-style string input using the generic input modal
export function sor_giris(baslik, aciklama, placeholder = "") {
  return new Promise((resolve) => {
    const modal = document.getElementById("genel-giris-modal");
    if (!modal) { resolve(window.prompt(aciklama) || null); return; }
    document.getElementById("ggm-baslik").textContent = baslik;
    document.getElementById("ggm-aciklama").textContent = aciklama;
    const input = document.getElementById("ggm-input");
    input.value = "";
    input.placeholder = placeholder;
    modal.classList.add("aktif");
    input.focus();

    function kapat(deger) {
      modal.classList.remove("aktif");
      document.getElementById("ggm-iptal").onclick = null;
      document.getElementById("ggm-tamam").onclick = null;
      input.onkeydown = null;
      resolve(deger);
    }
    document.getElementById("ggm-tamam").onclick = () => kapat(input.value.trim() || null);
    document.getElementById("ggm-iptal").onclick = () => kapat(null);
    input.onkeydown = (e) => { if (e.key === "Enter") kapat(input.value.trim() || null); };
  });
}
