/* Last-resort boot guard for browsers that cannot run the module reader. */
(function () {
  var app = document.getElementById("app");
  if (!app) return;
  var copy = {
    "zh-CN": {
      old: "当前浏览器不支持阅读器所需的现代脚本，请在系统浏览器中打开此链接。",
      failed: "阅读器加载失败，请刷新重试，或复制链接到系统浏览器打开。",
      slow: "加载时间较长，请检查手机与电脑是否在同一局域网，然后刷新重试。",
      retry: "刷新",
    },
    "zh-TW": {
      old: "目前瀏覽器不支援閱讀器所需的現代腳本，請在系統瀏覽器中開啟此連結。",
      failed: "閱讀器載入失敗，請重新整理，或複製連結到系統瀏覽器開啟。",
      slow: "載入時間較長，請確認手機與電腦在同一區域網路，然後重新整理。",
      retry: "重新整理",
    },
    en: {
      old: "This browser does not support the scripts the reader needs. Open this link in your system browser.",
      failed: "The reader failed to load. Reload, or copy the link into your system browser.",
      slow: "Still loading. Check that the phone and computer are on the same LAN, then reload.",
      retry: "Reload",
    },
    es: {
      old: "Este navegador no admite los scripts que necesita el lector. Abre el enlace en el navegador del sistema.",
      failed: "El lector no se pudo cargar. Recarga o abre el enlace en el navegador del sistema.",
      slow: "Sigue cargando. Comprueba que el teléfono y el ordenador están en la misma LAN y recarga.",
      retry: "Recargar",
    },
    ja: {
      old: "このブラウザはリーダーに必要なスクリプトに対応していません。システムブラウザで開いてください。",
      failed: "リーダーを読み込めませんでした。再読み込みするか、リンクをシステムブラウザで開いてください。",
      slow: "読み込みが長引いています。スマートフォンと PC が同じ LAN にあるか確認して再読み込みしてください。",
      retry: "再読み込み",
    },
    ko: {
      old: "이 브라우저는 리더에 필요한 스크립트를 지원하지 않습니다. 시스템 브라우저에서 링크를 여세요.",
      failed: "리더를 불러오지 못했습니다. 새로고침하거나 링크를 시스템 브라우저에서 여세요.",
      slow: "로딩이 오래 걸립니다. 휴대폰과 컴퓨터가 같은 LAN에 있는지 확인한 뒤 새로고침하세요.",
      retry: "새로고침",
    },
  };
  var preferred = navigator.language || "en";
  var locale = preferred.indexOf("zh") === 0
    ? (/TW|HK|Hant/i.test(preferred) ? "zh-TW" : "zh-CN")
    : (["es", "ja", "ko"].filter(function (x) { return preferred.indexOf(x) === 0; })[0] || "en");
  var text = copy[locale] || copy.en;
  function show(message) {
    if (window.__moyuBooted) return;
    var panel = document.createElement("section");
    panel.className = "notice notice-error boot-error";
    var paragraph = document.createElement("p");
    paragraph.textContent = message;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary";
    button.textContent = text.retry;
    button.addEventListener("click", function () { location.reload(); });
    panel.appendChild(paragraph);
    panel.appendChild(button);
    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(panel);
  }
  window.__moyuFail = show;
  if (!("noModule" in HTMLScriptElement.prototype)) {
    show(text.old);
    return;
  }
  var timer = window.setTimeout(function () { show(text.slow); }, 12000);
  window.__moyuBooted = function () { window.clearTimeout(timer); };
  window.addEventListener("error", function (event) {
    // Resource errors from CSS/images are not fatal; only script failures and
    // uncaught runtime errors should replace the page.
    if (event.target && event.target.tagName && event.target.tagName !== "SCRIPT") return;
    show(text.failed);
  }, true);
  window.addEventListener("unhandledrejection", function () { show(text.failed); });
})();
