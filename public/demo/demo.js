const keys = ["try","samples","download","return","eyebrow","headline","intro","start","view","notice","live","tryTitle","tryDescription","demoLibrary","simulation","sky","manga","rain","webtoon","space","comic","single","scroll","samplesLabel","sampleTitle","sampleDescription","mangaDesc","rainDesc","spaceDesc","sampleDownload","limits","footer","realLabel","realTitle","realCaption","europa","scifi","europaDesc","previous","next","pageLabel","readerHint"];
const translations = {
  "zh-CN": ["体验演示","示例漫画","下载 Moyu ↗","返回应用","一本属于你的漫画书库","喜欢的故事，\n随时打开。","本地整理，舒适阅读。从一个简单的书库开始，回到阅读本身。","开始体验 ↗","认识示例漫画 ↓","这是简化的交互演示，不会读取你的本地文件或保存阅读进度。","互动演示","一本书，一种阅读方式。","选择一本示例漫画，再切换阅读布局。","演示书库","模拟演示","天空站与机械鸟","黑白分镜","雨天咖啡馆","彩色条漫","星轨温室","彩色分镜","单页","条漫","四段小故事","四个故事，一份书库。","AI 生成的演示素材，适合用来体验本地阅读。","在云上的车站，遇见一只小小的机械鸟。","一杯咖啡里，藏着一朵等雨停的小云。","星空下，一位机械师与她的小小伙伴。","下载示例 CBZ ↓","科幻示例包含封面和四页正文；不能代替超长图切片测试。应用不内置在线漫画源。","把喜欢的故事留在身边。","真实界面","在自己的书库里相遇。","桌面应用开发版截图；使用隔离书库和 AI 生成的示例漫画。","木卫二的回声","写实科幻 · 5 页","宇航员与维修机器人在冰原上重启失联的科研站。","← 上一页","下一页 →","页码","阅读区域可用左右方向键翻页；条漫模式连续滚动。"],
  "zh-TW": ["互動示範","示範漫畫","下載 Moyu ↗","返回應用程式","屬於你的漫畫書庫","喜歡的故事，\n隨時打開。","在本機整理，舒適閱讀。從簡單的書庫開始，回到閱讀本身。","開始體驗 ↗","認識示範漫畫 ↓","這是簡化的互動示範，不會讀取本機檔案或儲存閱讀進度。","互動示範","一本書，一種閱讀方式。","選擇示範漫畫，再切換閱讀版面。","示範書庫","模擬示範","天空站與機械鳥","黑白分鏡","雨天咖啡館","彩色條漫","星軌溫室","彩色分鏡","單頁","條漫","四段小故事","四個故事，一份書庫。","AI 生成的示範素材，適合體驗本機閱讀。","在雲上的車站，遇見一隻小小的機械鳥。","一杯咖啡裡，藏著一朵等雨停的小雲。","星空下，一位機械師與她的小小夥伴。","下載示範 CBZ ↓","科幻示範包含封面與四頁正文；不能取代超長圖切片測試。應用程式不內建線上漫畫來源。","把喜歡的故事留在身邊。","真實介面","在自己的書庫裡相遇。","桌面應用程式開發版截圖；使用隔離書庫與 AI 生成的示範漫畫。","木衛二的回聲","寫實科幻 · 5 頁","太空人與維修機器人在冰原上重啟失聯的科研站。","← 上一頁","下一頁 →","頁碼","閱讀區域可用左右方向鍵翻頁；條漫模式連續捲動。"],
  "en": ["Try demo","Sample comics","Download Moyu ↗","Back to app","A library of your own","Your favorite stories,\nready when you are.","Organize locally and settle into a comfortable reading experience.","Try the demo ↗","Meet the samples ↓","This is a simplified demo. It does not read local files or save progress.","INTERACTIVE DEMO","One book, your way.","Choose a sample, then switch the reading layout.","Demo library","SIMULATED","Sky Station and the Mechanical Bird","Black-and-white manga","Rainy Day Café","Color webtoon","Orbital Greenhouse","Color comic","Page","Scroll","FOUR LITTLE STORIES","Four stories, one library.","AI-generated samples for exploring local reading.","A tiny mechanical bird at a station above the clouds.","A little cloud waits out the rain in a cup of coffee.","A mechanic and her small companion under the stars.","Download sample CBZ ↓","The sci-fi sample has a cover and four pages. It does not test long-image slicing. The app does not bundle online sources.","Keep the stories you love close.","REAL APP","Meet your own library.","Desktop development-build screenshot using an isolated library and AI-generated samples.","Echoes of Europa","Realistic sci-fi · 5 pages","An astronaut and a repair drone restore a silent research station.","← Previous","Next →","Page","Use arrow keys in the reading area; scroll mode shows all pages."],
  "es": ["Probar demo","Cómics de muestra","Descargar Moyu ↗","Volver a la aplicación","Una biblioteca propia","Tus historias favoritas,\nsiempre a mano.","Organiza tu biblioteca local y disfruta de una lectura cómoda.","Probar la demo ↗","Ver las muestras ↓","Esta demo simplificada no lee archivos locales ni guarda el progreso.","DEMO INTERACTIVA","Un libro, a tu manera.","Elige una muestra y cambia el modo de lectura.","Biblioteca de muestra","SIMULACIÓN","La estación y el pájaro mecánico","Manga en blanco y negro","Café en un día de lluvia","Webtoon a color","Invernadero orbital","Cómic a color","Página","Desplazar","CUATRO HISTORIAS","Cuatro historias, una biblioteca.","Muestras generadas por IA para explorar la lectura local.","Un pájaro mecánico en una estación sobre las nubes.","Una nube espera a que pase la lluvia en una taza.","Una mecánica y su pequeño compañero bajo las estrellas.","Descargar CBZ ↓","La muestra de ciencia ficción tiene portada y cuatro páginas. No prueba el corte de imágenes largas. La aplicación no incluye fuentes en línea.","Conserva cerca tus historias favoritas.","APLICACIÓN REAL","Tu propia biblioteca.","Captura de desarrollo con una biblioteca aislada y muestras generadas por IA.","Ecos de Europa","Ciencia ficción realista · 5 páginas","Una astronauta y un robot reparan una estación de investigación.","← Anterior","Siguiente →","Página","Usa las flechas en el área de lectura; el modo vertical muestra todas las páginas."],
  "ja": ["デモを試す","サンプル漫画","Moyu をダウンロード ↗","アプリに戻る","自分だけの漫画ライブラリ","好きな物語を、\nいつでも手元に。","ローカルで整理して、快適に読む。シンプルな本棚から始めましょう。","デモを始める ↗","サンプルを見る ↓","これは簡易デモです。ローカルファイルの読み取りや進捗の保存は行いません。","体験デモ","一冊を、好きな読み方で。","サンプルを選び、表示方法を切り替えます。","デモ本棚","簡易デモ","空の駅と機械の鳥","モノクロ漫画","雨の日のカフェ","カラー縦読み","軌道上の温室","カラー漫画","ページ","縦読み","4つの小さな物語","4つの物語、1つの本棚。","ローカル読書の体験用にAIで生成したサンプルです。","雲の上の駅で、小さな機械の鳥に出会います。","コーヒーカップの中で小さな雲が雨上がりを待っています。","星空の下、整備士と小さな仲間が出会います。","サンプル CBZ をダウンロード ↓","SFサンプルは表紙と本文4ページです。超長画像の分割テストには使えません。オンライン漫画ソースは含まれません。","好きな物語を、いつもそばに。","実際の画面","自分だけの本棚で出会う。","分離された本棚と AI 生成サンプルを使ったデスクトップ開発版の画面です。","エウロパの残響","写実SF · 5ページ","宇宙飛行士と修理ロボットが氷原の研究基地を復旧します。","← 前へ","次へ →","ページ","読書領域では左右キーで移動、縦読みでは全ページを表示します。"],
  "ko": ["데모 체험","샘플 만화","Moyu 다운로드 ↗","앱으로 돌아가기","나만의 만화 서재","좋아하는 이야기를,\n언제든 펼쳐 보세요.","내 기기에서 정리하고 편안하게 읽으세요. 간단한 서재에서 시작합니다.","데모 시작 ↗","샘플 만화 보기 ↓","간단한 체험 화면입니다. 로컬 파일을 읽거나 진행 상황을 저장하지 않습니다.","인터랙티브 데모","한 권을 원하는 방식으로.","샘플을 고르고 읽기 방식을 바꿔 보세요.","데모 서재","체험 화면","하늘역과 기계 새","흑백 만화","비 오는 날의 카페","컬러 웹툰","궤도 온실","컬러 만화","한 페이지","스크롤","네 가지 작은 이야기","네 가지 이야기, 하나의 서재.","로컬 읽기 체험을 위해 AI로 생성한 샘플입니다.","구름 위 역에서 작은 기계 새를 만납니다.","커피 잔 속 작은 구름이 비가 그치기를 기다립니다.","별 아래 정비사와 작은 친구의 이야기입니다.","샘플 CBZ 다운로드 ↓","SF 샘플은 표지와 본문 네 페이지입니다. 초장편 이미지 분할 테스트를 대체하지 않습니다. 앱에 온라인 만화 출처는 포함되지 않습니다.","좋아하는 이야기를 곁에 두세요.","실제 앱 화면","나만의 서재에서 만나요.","격리된 서재와 AI 생성 샘플을 사용한 데스크톱 개발 빌드 화면입니다.","유로파의 메아리","사실적 SF · 5페이지","우주비행사와 수리 로봇이 얼음 연구기지의 신호를 복구합니다.","← 이전","다음 →","페이지","읽기 영역에서 방향키로 넘기고 스크롤 모드에서 이어 읽으세요."],
};

try { const theme = localStorage.getItem('mr-theme'); if (theme === 'dark' || theme === 'light') document.documentElement.dataset.demoTheme = theme; } catch {}
let language = 'zh-CN';
try { language = localStorage.getItem('mr-locale') || navigator.language; } catch { language = navigator.language; }
if (!translations[language]) language = language?.startsWith('zh') ? 'zh-CN' : language?.slice(0, 2);
if (!translations[language]) language = 'en';
const dict = Object.fromEntries(keys.map((key, i) => [key, translations[language][i]]));
const t = (key) => dict[key] || translations.en[keys.indexOf(key)] || '';
document.documentElement.lang = language;
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
document.querySelectorAll('[data-i18n-alt]').forEach(el => { el.alt = t(el.dataset.i18nAlt); });
let inApp = !!window.__TAURI_INTERNALS__;
try { inApp ||= !!window.parent.__TAURI_INTERNALS__; } catch {}
const framed = window.parent !== window;
document.querySelectorAll('[data-external]').forEach(el => { el.hidden = inApp; });
document.querySelectorAll('[data-return]').forEach(el => { el.hidden = !inApp || framed; });
const books = {
  sky: { title: 'sky', pages: ['sky-cover.png','sky-station.png'] },
  rain: { title: 'rain', pages: ['rain-cover.png','rain-cafe.png'] },
  space: { title: 'space', pages: ['orbital-cover.png','orbital-garden.png'] },
  europa: { title: 'europa', pages: ['europa-cover.png','europa-01.png','europa-02.png','europa-03.png','europa-04.png'] },
};
const page = document.querySelector('#current-page');
const stack = document.querySelector('#page-stack');
const area = document.querySelector('#reading-area');
const previous = document.querySelector('#previous-page');
const next = document.querySelector('#next-page');
const count = document.querySelector('#page-count');
let currentBook = 'sky';
let currentPage = 0;
let mode = 'page';
function renderReader() {
  const book = books[currentBook];
  page.src = `./assets/${book.pages[currentPage]}`;
  page.alt = `${t(book.title)} · ${currentPage + 1}`;
  document.querySelector('#current-title').textContent = t(book.title);
  count.textContent = mode === 'page' ? `${currentPage + 1} / ${book.pages.length}` : t('scroll');
  count.setAttribute('aria-label', `${t('pageLabel')}: ${count.textContent}`);
  previous.hidden = next.hidden = mode !== 'page';
  previous.disabled = currentPage === 0;
  next.disabled = currentPage === book.pages.length - 1;
  area.classList.toggle('page', mode === 'page');
  area.classList.toggle('scroll', mode === 'scroll');
  stack.hidden = mode !== 'scroll';
  if (mode === 'scroll') {
    const images = book.pages.map((filename, index) => {
      const image = document.createElement('img');
      image.src = `./assets/${filename}`;
      image.alt = `${t(book.title)} · ${index + 1}`;
      image.loading = 'lazy';
      return image;
    });
    stack.replaceChildren(...images);
  } else stack.replaceChildren();
  area.scrollTop = 0;
}
function turnPage(delta) {
  const max = books[currentBook].pages.length - 1;
  currentPage = Math.max(0, Math.min(max, currentPage + delta));
  renderReader();
}
document.querySelectorAll('[data-book]').forEach(button => button.addEventListener('click', () => {
  currentBook = button.dataset.book;
  currentPage = 0;
  document.querySelectorAll('[data-book]').forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); });
  renderReader();
}));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(item => { const selected = item === button; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', String(selected)); });
  renderReader();
}));
previous.addEventListener('click', () => turnPage(-1));
next.addEventListener('click', () => turnPage(1));
area.addEventListener('keydown', event => {
  if (event.target !== area || mode !== 'page' || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    turnPage(event.key === 'ArrowRight' ? 1 : -1);
  }
});
renderReader();
