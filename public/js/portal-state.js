export const state = {
  // Auth
  kullanici: null,
  rol: null,
  ogretmenDoc: null,

  // Cached lists
  ogretmenler: [],
  siniflar: [],
  gorevler: [],

  // Yoklamalarım (time-locked)
  ymTimer: null,
  ymSaatler: {},
  ymDersler: [],

  // DYK teacher
  dykTimer: null,
  dykKurslar: [],

  // Yoklama modal
  aktifDers: null,

  // Görev
  gorevFiltresi: "hepsi",
  gorevOnayPendingId: null,
  gorevOnayTip: null,

  // Kazanım
  kazanimExcelVerisi: [],
  aktifKazanimDersId: null,

  // Bildirim
  bildirimler: [],

  // Admin interval
  takipInterval: null,
};
