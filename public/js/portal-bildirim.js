import {
  db,
  getDocs, updateDoc,
  collection, query, where, doc,
} from "./portal-config.js";
import { state } from "./portal-state.js";

export async function bildirimleriYukle() {
  if (!state.ogretmenDoc) return;
  try {
    const snap = await getDocs(
      query(
        collection(db, "bildirimler"),
        where("alici_id", "==", state.ogretmenDoc.id),
        where("okundu", "==", false),
      ),
    );
    state.bildirimler = [];
    snap.forEach((d) => state.bildirimler.push({ id: d.id, ...d.data() }));
    state.bildirimler.sort((a, b) => {
      const ta = a.tarih?.toMillis?.() || 0;
      const tb = b.tarih?.toMillis?.() || 0;
      return tb - ta;
    });
    _bildirimRozetGuncelle();
    const btn = document.getElementById("bildirimBtn");
    if (btn) btn.style.display = "flex";
  } catch (e) {
    console.warn("Bildirim yukleme hatasi:", e);
  }
}

function _bildirimRozetGuncelle() {
  const rozet = document.getElementById("bildirimRozet");
  if (!rozet) return;
  if (state.bildirimler.length > 0) {
    rozet.textContent = state.bildirimler.length > 9 ? "9+" : state.bildirimler.length;
    rozet.style.display = "flex";
  } else {
    rozet.style.display = "none";
  }
}

window.bildirimPanelToggle = () => {
  const panel = document.getElementById("bildirimPanel");
  if (!panel) return;
  const aciliyor = !panel.classList.contains("acik");
  panel.classList.toggle("acik");
  if (aciliyor) _bildirimPanelIcerikGoster();
};

function _bildirimPanelIcerikGoster() {
  const panel = document.getElementById("bildirimPanel");
  if (!panel) return;
  if (!state.bildirimler.length) {
    panel.innerHTML = `<div class="bildirim-bos">🔔 Okunmamis bildirim yok.</div>`;
    return;
  }
  const tipIkonu = { anket: "📋", gorev: "📌", duyuru: "📢" };
  let html = `<div class="bildirim-panel-baslik"><span>BİLDİRİMLER (${state.bildirimler.length})</span></div>`;
  state.bildirimler.forEach((b) => {
    const ikon = tipIkonu[b.tip] || "🔔";
    html += `<div class="bildirim-item" onclick="bildirimOku('${b.id}','${b.tip}','${b.referans_id || ''}')">
      <div class="bildirim-item-baslik">${ikon} ${b.baslik}</div>
      ${b.mesaj ? `<div class="bildirim-item-mesaj">${b.mesaj}</div>` : ""}
    </div>`;
  });
  html += `<div class="bildirim-tumunu-oku"><button onclick="tumBildirimleriOku()">Tumunu okundu isaretle</button></div>`;
  panel.innerHTML = html;
}

window.bildirimOku = async (bildirimId, tip, referansId) => {
  try {
    await updateDoc(doc(db, "bildirimler", bildirimId), { okundu: true });
  } catch (e) {}
  state.bildirimler = state.bildirimler.filter((b) => b.id !== bildirimId);
  _bildirimRozetGuncelle();
  document.getElementById("bildirimPanel")?.classList.remove("acik");

  if (tip === "anket") {
    window.location.href = "/anket.html" + (referansId ? "?id=" + referansId : "");
  } else if (tip === "gorev") {
    window.sayfaGoster("gorevlerim", "Görevlerim", document.getElementById("menu-gorevlerim"));
  }
};

window.tumBildirimleriOku = async () => {
  await Promise.all(
    state.bildirimler.map((b) =>
      updateDoc(doc(db, "bildirimler", b.id), { okundu: true }).catch(() => {}),
    ),
  );
  state.bildirimler = [];
  _bildirimRozetGuncelle();
  document.getElementById("bildirimPanel")?.classList.remove("acik");
};

// Panel disina tiklaninca kapat
document.addEventListener("click", (e) => {
  const sarici = document.querySelector(".bildirim-sarici");
  if (sarici && !sarici.contains(e.target)) {
    document.getElementById("bildirimPanel")?.classList.remove("acik");
  }
});
