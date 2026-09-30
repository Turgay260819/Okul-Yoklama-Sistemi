// Firebase'in "Missing or insufficient permissions" hatasini Turkce, anlasilir
// bir mesaja cevirir. Sayfalar hatayi genelde err.message ile ekrana yazdigi
// icin DOM'daki metni yerinde degistiriyoruz; yakalanmamis hatalar icin de
// kisa bir bildirim gosteriyoruz. Asil koruma firestore.rules'tadir — bu dosya
// sadece salt-okunur idareci (idareci_izleyici) hesabinin gordugu mesajlari
// duzeltir.
(function () {
  const INGILIZCE = /Missing or insufficient permissions\.?|PERMISSION_DENIED|permission-denied/g;
  const MESAJ = "Bu hesap sadece görüntüleme yetkisine sahip, değişiklik yapamazsınız.";

  function metniCevir(kok) {
    const walker = document.createTreeWalker(kok, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (INGILIZCE.test(n.nodeValue)) {
        INGILIZCE.lastIndex = 0;
        n.nodeValue = MESAJ;
      }
      INGILIZCE.lastIndex = 0;
    }
  }

  function bildirimGoster() {
    let el = document.getElementById("saltOkunurBildirim");
    if (!el) {
      el = document.createElement("div");
      el.id = "saltOkunurBildirim";
      el.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;" +
        "background:#c62828;color:#fff;padding:10px 18px;border-radius:8px;font-size:14px;" +
        "box-shadow:0 4px 12px rgba(0,0,0,.25);max-width:90vw;text-align:center;";
      document.body.appendChild(el);
    }
    el.textContent = MESAJ;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 4000);
  }

  function yetkiHatasiMi(err) {
    const s = String((err && (err.code || "")) + " " + (err && (err.message || err)));
    INGILIZCE.lastIndex = 0;
    return INGILIZCE.test(s);
  }

  window.addEventListener("unhandledrejection", (e) => {
    if (yetkiHatasiMi(e.reason)) bildirimGoster();
  });

  const _alert = window.alert;
  window.alert = function (msg) {
    INGILIZCE.lastIndex = 0;
    return _alert.call(window, typeof msg === "string" && INGILIZCE.test(msg) ? MESAJ : msg);
  };

  function baslat() {
    metniCevir(document.body);
    new MutationObserver((kayitlar) => {
      for (const k of kayitlar) {
        k.addedNodes.forEach((node) => {
          if (node.nodeType === 3) metniCevir(node.parentNode || document.body);
          else if (node.nodeType === 1) metniCevir(node);
        });
        if (k.type === "characterData" && k.target.parentNode) metniCevir(k.target.parentNode);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) baslat();
  else document.addEventListener("DOMContentLoaded", baslat);
})();
