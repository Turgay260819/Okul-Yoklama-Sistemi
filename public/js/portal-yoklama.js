import {
  db, bugun,
  getDocs, addDoc, updateDoc,
  collection, query, where, doc, serverTimestamp,
} from "./portal-config.js";
import { state } from "./portal-state.js";
import { esc } from "./portal-utils.js";

// ── YOKLAMA MODAL (Admin / Derslerim'den açılan) ──
window.yoklamaAc = async (dersId, classId, lessonNo, lessonName, teacherId) => {
  state.aktifDers = { dersId, classId, lessonNo, lessonName, teacherId };
  document.getElementById("modalBaslik").textContent = `${lessonNo}. Ders - ${classId}`;
  document.getElementById("modalAltBaslik").textContent = lessonName;
  const modalOgr = document.getElementById("modalOgretmen");
  for (const opt of modalOgr.options) {
    if (opt.value === teacherId) { opt.selected = true; break; }
  }
  const snap = await getDocs(
    query(collection(db, "students"), where("class_id", "==", classId), where("status", "==", "active")),
  );
  let ogrenciler = [];
  snap.forEach((d) => ogrenciler.push({ id: d.id, ...d.data() }));
  ogrenciler.sort((a, b) => a.student_number.localeCompare(b.student_number));
  let html = "";
  ogrenciler.forEach((o) => {
    html += `<div class="ogrenci-satir" id="satir-${o.student_number}" onclick="yokIsaretle('${o.student_number}')">
      <input type="checkbox" id="chk-${o.student_number}" onclick="event.stopPropagation(); yokIsaretle('${o.student_number}')">
      <span class="ogrenci-no">${esc(o.student_number)}</span>
      <span class="ogrenci-isim">${esc(o.name)}</span>
    </div>`;
  });
  document.getElementById("modalOgrenciListesi").innerHTML = html;
  document.getElementById("yoklamaOzet").textContent = "Tum ogrenciler mevcut";
  document.getElementById("yoklamaModal").classList.add("aktif");
};

window.yokIsaretle = (no) => {
  const chk = document.getElementById("chk-" + no);
  chk.checked = !chk.checked;
  document.getElementById("satir-" + no).classList.toggle("yok", chk.checked);
  const y = document.querySelectorAll("#modalOgrenciListesi input:checked").length;
  document.getElementById("yoklamaOzet").textContent =
    y === 0 ? "Tum ogrenciler mevcut" : y + " ogrenci yok isaretlendi";
};

window.modalYoklamaKaydet = async () => {
  if (!state.aktifDers) return;
  const yoklar = [];
  document.querySelectorAll("#modalOgrenciListesi input:checked").forEach((c) =>
    yoklar.push(c.id.replace("chk-", "")),
  );
  try {
    await addDoc(collection(db, "attendance"), {
      date: bugun,
      class_id: state.aktifDers.classId,
      lesson_number: state.aktifDers.lessonNo,
      lesson_name: state.aktifDers.lessonName,
      teacher_id: state.aktifDers.teacherId,
      actual_teacher: document.getElementById("modalOgretmen").value,
      absent_students: yoklar,
      created_at: serverTimestamp(),
      entered_at: serverTimestamp(),
      is_late_entry: new Date().getHours() >= 9,
      locked: true,
    });
    await updateDoc(doc(db, "today_lessons", state.aktifDers.dersId), { status: "filled" });
    window.modalKapat();
    window.dersleriniYukle();
    window.anasayfaYukle();
  } catch (err) {
    console.error("Yoklama kaydetme hatası:", err);
  }
};

window.modalKapat = () => {
  document.getElementById("yoklamaModal").classList.remove("aktif");
  state.aktifDers = null;
};
window.modalKapat2 = () => {
  document.getElementById("gorevOnayModal").classList.remove("aktif");
  state.gorevOnayPendingId = null;
  state.gorevOnayTip = null;
};
