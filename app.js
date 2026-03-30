/* ═══════════════════════════════════════════════════════
   SkillForge — Frontend Application
   ═══════════════════════════════════════════════════════ */

'use strict';

// ── 配置 ──────────────────────────────────────────────────
const PROXY = 'proxy.php';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 最大上传文件：50 MB
const MAX_LLM_CHARS  = 40_000;   // 超过此长度截断后发给 LLM
const MAX_REF_CHARS  = 120_000;  // references/content.md 最大长度
const MAX_RETRIES          = 24;  // 队列满时最大重试次数
const RETRY_SECS           = 20;  // 每次重试等待秒数
const PLATFORM_NET_RETRIES = 3;   // 平台模型连续网络错误最大重试次数

// PDF.js 本地库路径（由 setup.php 下载到 lib/ 目录）
const PDFJS_URL    = 'lib/pdf.min.js';
const PDFJS_WORKER = 'lib/pdf.worker.min.js';

// Tesseract.js 本地 OCR（所有文件由 setup.php 下载到 lib/ 目录）
const OCR_SCALE   = 1.5;  // 渲染分辨率倍数（1.5 平衡速度与精度）
const OCR_WORKERS = Math.max(2, Math.min(4, navigator.hardwareConcurrency || 2));

// ── 全局状态 ──────────────────────────────────────────────
const S = {
  content:       '',       // 已提取的原始文本
  fileName:      '',       // 来源文件名或 URL
  selectedModel: null,     // { id, format }
  useCustom:     false,    // 是否使用自定义 API
  customFmt:     'openai',
  isRunning:     false,
  aborted:       false,
  resultBlob:    null,
  resultName:    '',
  countdownTimer:null,
};

// ── DOM 工具 ──────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

// ─────────────────────────────────────────────────────────
//  初始化
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupFileZone();
  setupURLFetch();
  setupTextInput();
  setupApiToggle();
  setupButtons();
  loadCustomApi();      // 恢复上次保存的自定义 API 配置
  await loadModels();
  updateGenBtn();
});

// ─────────────────────────────────────────────────────────
//  加载平台模型
// ─────────────────────────────────────────────────────────
async function loadModels() {
  const grid = $('model-grid');
  try {
    const r = await fetch(`${PROXY}?action=models`);
    const d = await r.json();
    const models = d.models || [];
    if (!models.length) throw new Error('empty');

    grid.innerHTML = models.map((m, i) => `
      <div class="model-card${i === 0 ? ' selected' : ''}"
           data-id="${m.id}" data-fmt="${m.format || 'openai'}"
           role="button" tabindex="0">
        <div class="model-name">${esc(m.name)}</div>
        <div class="model-desc">${esc(m.description)}</div>
      </div>`).join('');

    S.selectedModel = { id: models[0].id, format: models[0].format || 'openai' };

    grid.addEventListener('click', e => {
      const card = e.target.closest('.model-card');
      if (!card) return;
      grid.querySelectorAll('.model-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      S.selectedModel = { id: card.dataset.id, format: card.dataset.fmt };
      updateGenBtn();
    });

  } catch {
    grid.innerHTML = '<p class="model-loading">⚠ 无法加载模型列表，请使用"自定义 API"</p>';
    S.selectedModel = null;
  }
}

// ─────────────────────────────────────────────────────────
//  标签页切换
// ─────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      // 切换标签时清除来自其他标签的内容
      const activeTab = tab.dataset.tab;
      if (activeTab !== 'text' && activeTab !== 'file') {
        // url tab ——不主动清空，保留已抓取内容
      }
      if (activeTab === 'text') {
        S.content  = $('text-input').value;
        S.fileName = '';
      }
      updateGenBtn();
    });
  });
}

// ─────────────────────────────────────────────────────────
//  文件上传 & 拖放
// ─────────────────────────────────────────────────────────
function setupFileZone() {
  const zone  = $('drop-zone');
  const input = $('file-input');

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  });

  input.addEventListener('change', e => { if (e.target.files[0]) processFile(e.target.files[0]); });

  $('remove-file').addEventListener('click', () => {
    S.content = ''; S.fileName = '';
    input.value = '';
    hide('file-selected');
    hide('upload-parsing');
    show('drop-inner');
    setParseStatus('file', '');
    updateGenBtn();
  });
}

// ── 进度条更新 ──
function setProgress(pct, statusText) {
  $('progress-fill').style.width = `${Math.min(pct, 100)}%`;
  $('parsing-pct').textContent   = `${Math.min(Math.round(pct), 100)}%`;
  if (statusText) {
    const el = $('parsing-status-text');
    el.textContent = statusText;
    // OCR 模式时橙色高亮提示
    el.classList.toggle('ocr-mode', statusText.includes('OCR'));
  }
}

// ── 进入解析状态（显示进度条）──
function showParsing(file) {
  const ext = file.name.split('.').pop().toUpperCase();
  const icons = { PDF: '📕', DOCX: '📘', DOC: '📘', TXT: '📄', MD: '📋' };
  $('parsing-icon').textContent      = icons[ext] || '📄';
  $('parsing-name').textContent      = file.name;
  $('parsing-status-text').textContent = '准备中…';
  $('parsing-pct').textContent       = '0%';
  $('progress-fill').style.width     = '0%';
  hide('drop-inner');
  hide('file-selected');
  show('upload-parsing');
}

// ── 解析完成，切换到完成状态 ──
function showParseDone(file, charCount) {
  hide('upload-parsing');
  $('file-sel-name').textContent = file.name;
  $('file-sel-size').textContent = formatBytes(file.size);
  show('file-selected');
}

async function processFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`文件超过 50 MB 限制（当前 ${formatBytes(file.size)}）`, 'error');
    return;
  }

  S.fileName = file.name;
  S.content  = '';

  showParsing(file);
  setParseStatus('file', '');
  updateGenBtn();

  try {
    const ext = file.name.split('.').pop().toLowerCase();
    let text = '';

    if (ext === 'pdf') {
      text = await parsePDF(file);
    } else if (ext === 'docx' || ext === 'doc') {
      setProgress(30, '正在读取 Word 文档…');
      text = await parseWord(file);
      setProgress(100, '解析完成');
    } else {
      setProgress(30, '正在读取文本…');
      text = await readTextWithProgress(file, pct => setProgress(pct, `正在读取… ${pct}%`));
      setProgress(100, '读取完成');
    }

    if (!text.trim()) throw new Error('文件内容为空，请确认文件包含可提取的文字');
    S.content = text;

    showParseDone(file, text.length);
    setParseStatus('file', `解析完成，共提取 ${fmtNum(text.length)} 字符`, 'success');
    updateGenBtn();

  } catch (e) {
    S.content = '';
    hide('upload-parsing');
    show('drop-inner');
    setParseStatus('file', e.message, 'error');
    updateGenBtn();
  }
}

// ── PDF.js 懒加载（选中 PDF 时才注入脚本，避免首屏阻塞）──
let _pdfjsPromise = null;

async function loadPdfjs() {
  if (typeof pdfjsLib !== 'undefined') {
    ensurePdfjsWorker();
    return;
  }
  if (_pdfjsPromise) return _pdfjsPromise; // 防止并发重复注入

  _pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS_URL;
    s.onload  = () => { ensurePdfjsWorker(); resolve(); };
    s.onerror = () => {
      _pdfjsPromise = null; // 失败后允许重试
      reject(new Error('PDF 解析库下载失败，请检查网络连接后重试'));
    };
    document.head.appendChild(s);
  });

  return _pdfjsPromise;
}

function ensurePdfjsWorker() {
  if (typeof pdfjsLib !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
}

async function parsePDF(file) {
  // ① 加载 PDF.js
  setProgress(2, '正在加载 PDF 解析库（首次需下载，请稍候）…');
  await loadPdfjs();

  // ② 读取文件为 ArrayBuffer（带进度，占 2%~20%）
  setProgress(5, '正在读取文件…');
  const buf = await readArrayBuffer(file, p => {
    setProgress(5 + p * 0.15, `正在读取文件… ${p}%`);
  });

  // ③ 解析 PDF 结构
  setProgress(20, '正在解析 PDF 文档结构…');
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({
      data: buf,
      // CMap 文件用于解析中文等 CJK 字体，不配置时会产生 404 + 字体警告
      cMapUrl:    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }).promise;
  } catch (e) {
    throw new Error('PDF 文件解析失败，可能已损坏：' + e.message);
  }

  const total = pdf.numPages;

  // ④ 尝试文字层提取（占 20%~70%）
  // PDF.js 3.x items 中混有 TextMarkedContent（无 str 属性），需过滤
  let out = '';
  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const tc   = await page.getTextContent({ includeMarkedContent: false });
    let pageText = '';
    for (const item of tc.items) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }
    if (pageText.trim()) out += pageText.trim() + '\n\n';
    setProgress(20 + Math.round((i / total) * 50), `正在提取第 ${i} / ${total} 页文字…`);
  }

  // ⑤ 评估文字层密度：每页平均 < 100 字符视为扫描件（仅含页码/水印），转 OCR
  // 示例：200 页书仅 214 字符 → 1 字/页 → 扫描件；正常文字 PDF 每页通常 500+ 字符
  const charDensity = total > 0 ? out.trim().length / total : 0;
  if (out.trim().length >= 10 && charDensity >= 100) return out.trim();

  // ⑥ 文字层为空 → 自动切换本地 Tesseract OCR
  setProgress(70, '未检测到文字层，自动启用本地 OCR 识别…');
  return await ocrPDF(pdf, total);
}

// ─────────────────────────────────────────────────────────
//  本地 Tesseract.js OCR（扫描件 PDF，文件全部来自 lib/）
// ─────────────────────────────────────────────────────────
let _tesseractPromise = null;

async function loadTesseract() {
  if (typeof Tesseract !== 'undefined') return;
  if (_tesseractPromise) return _tesseractPromise;

  _tesseractPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src     = 'lib/tesseract.min.js';
    s.onload  = resolve;
    s.onerror = () => {
      _tesseractPromise = null;
      reject(new Error(
        'Tesseract.js 加载失败。\n请先访问 setup.php 完成依赖库安装。'
      ));
    };
    document.head.appendChild(s);
  });

  return _tesseractPromise;
}

// 检测本地 tessdata 是否可用且未被服务器自动解压
// Nginx gzip_static 会对 .gz 加 Content-Encoding: gzip，浏览器自动解压后
// Tesseract.js 收到明文数据再次解压 → 卡死在 0%，需回退到在线 CDN
async function getOcrLangPath() {
  try {
    const r = await fetch('lib/tessdata/chi_sim.traineddata.gz', { method: 'HEAD' });
    if (r.ok) {
      const enc = (r.headers.get('Content-Encoding') || '').toLowerCase();
      if (enc.includes('gzip')) {
        // 服务器在自动解压 .gz，会导致 Tesseract.js 卡死，切换 CDN
        console.warn(
          '[OCR] 检测到服务器 Content-Encoding: gzip（Nginx gzip_static），' +
          '已自动切换到在线 CDN。\n' +
          '如需使用本地文件，请在 Nginx 站点配置中添加：\n' +
          'location ~* \\.traineddata\\.gz$ { gzip off; gzip_static off; }'
        );
        return { path: 'https://tessdata.projectnaptha.com/4.0.0', isLocal: false };
      }
      return { path: 'lib/tessdata', isLocal: true };
    }
  } catch {}
  return { path: 'https://tessdata.projectnaptha.com/4.0.0', isLocal: false };
}

async function ocrPDF(pdf, totalPages) {
  // ── A：加载 Tesseract.js 主体 ──
  setProgress(70, '正在加载 OCR 引擎…');
  await loadTesseract();

  // ── A2：决定语言包来源 ──
  const { path: langPath, isLocal } = await getOcrLangPath();
  const langSrc = isLocal ? '本地 lib/tessdata/' : '在线 CDN（本地语言包未找到）';

  // ── B：并行创建多 Worker，追踪语言包加载进度 ──
  const dlProgress = new Array(OCR_WORKERS).fill(0);
  let   initDone   = 0;

  const makeLogger = (idx) => (m) => {
    if (m.status === 'loading language traineddata') {
      dlProgress[idx] = m.progress || 0;
      const avg = dlProgress.reduce((a, v) => a + v, 0) / OCR_WORKERS;
      setProgress(
        70 + avg * 8,
        `正在加载语言包… ${Math.round(avg * 100)}%（来自 ${langSrc}）`
      );
    } else if (m.status === 'initialized api') {
      initDone++;
      setProgress(
        78 + (initDone / OCR_WORKERS) * 2,
        `OCR 识别器初始化… ${initDone} / ${OCR_WORKERS} 就绪`
      );
    }
  };

  let workers;
  try {
    workers = await Promise.all(
      Array.from({ length: OCR_WORKERS }, (_, i) =>
        Tesseract.createWorker(['chi_sim', 'eng'], 1, {
          workerPath:    'lib/tesseract.worker.min.js',
          // workerBlobURL: false — 直接用 URL 加载 Worker，避免 Blob Worker
          // 被 Chrome Private Network Access 策略拦截（unknown address space）
          workerBlobURL: false,
          langPath,
          corePath:      'lib/tesseract-core.wasm.js',
          logger:        makeLogger(i),
        })
      )
    );
  } catch (e) {
    throw new Error('OCR 识别器初始化失败：' + e.message +
      '\n请先访问 setup.php 确认所有文件已下载。');
  }

  setProgress(80, `${OCR_WORKERS} 个识别器就绪，开始并行识别共 ${totalPages} 页…`);

  // ── C：Worker Pool 并行识别（无页数上限）──
  const results = new Array(totalPages + 1).fill(''); // 1-indexed
  let completed = 0;
  const queue   = Array.from({ length: totalPages }, (_, i) => i + 1);

  const runWorker = async (worker) => {
    while (true) {
      const pageNum = queue.shift();
      if (pageNum === undefined) break;
      try {
        const page   = await pdf.getPage(pageNum);
        const canvas = await renderPageToCanvas(page, OCR_SCALE);
        const { data: { text } } = await worker.recognize(canvas);
        results[pageNum] = text.trim();
        canvas.width = canvas.height = 0; // 释放内存
      } catch { /* 单页失败不中断 */ }
      completed++;
      setProgress(
        80 + Math.round((completed / totalPages) * 18),
        `OCR 识别中… ${completed} / ${totalPages} 页（${OCR_WORKERS} 路并行）`
      );
    }
  };

  await Promise.all(workers.map(w => runWorker(w)));
  await Promise.all(workers.map(w => w.terminate()));

  const out = results.slice(1).filter(t => t).join('\n\n');

  if (out.trim().length < 10) {
    throw new Error('OCR 未识别出有效文字，请确认 PDF 图像清晰（建议分辨率 ≥ 150 DPI）');
  }
  return out.trim();
}

// 将 PDF 页面渲染为 Canvas
async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas   = document.createElement('canvas');
  canvas.width   = viewport.width;
  canvas.height  = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

// 带进度回调的 ArrayBuffer 读取
function readArrayBuffer(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

async function parseWord(file) {
  if (typeof mammoth === 'undefined') {
    throw new Error('Word 解析库未加载，请刷新页面后重试');
  }
  setProgress(20, '正在解析 Word 文档…');
  const buf    = await file.arrayBuffer();
  setProgress(70, '正在提取文字内容…');
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  setProgress(100, '解析完成');
  return result.value;
}

function readTextWithProgress(file, onProgress) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 90));
      }
    };
    reader.onload  = e => res(e.target.result);
    reader.onerror = () => rej(new Error('文件读取失败'));
    reader.readAsText(file, 'UTF-8');
  });
}

// ─────────────────────────────────────────────────────────
//  网页链接抓取
// ─────────────────────────────────────────────────────────
function setupURLFetch() {
  $('fetch-btn').addEventListener('click', doFetch);
  $('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') doFetch(); });
}

async function doFetch() {
  const url = $('url-input').value.trim();
  if (!url) { toast('请先输入链接', 'error'); return; }

  setParseStatus('url', '正在抓取网页内容…', 'loading');
  S.content = ''; S.fileName = url;
  updateGenBtn();

  try {
    const r = await fetch(`${PROXY}?action=fetch&url=${encodeURIComponent(url)}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);

    const text = html2text(d.html);
    if (text.length < 50) throw new Error('未能提取到有效内容，请尝试粘贴文本');

    S.content = text;
    setParseStatus('url', `✅ 抓取成功，共 ${fmtNum(text.length)} 字符`, 'success');
    updateGenBtn();
  } catch (e) {
    setParseStatus('url', `❌ ${e.message}`, 'error');
    S.content = '';
    updateGenBtn();
  }
}

function html2text(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 移除无关元素
  doc.querySelectorAll('script,style,nav,header,footer,aside,iframe,noscript,[role="navigation"]')
     .forEach(el => el.remove());
  // 优先取主内容区
  const selectors = [
    'article', 'main', '#js_content', '.rich_media_content',
    '.article-content', '.post-content', '.content', 'body'
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) {
      const t = (el.innerText || el.textContent || '').trim();
      if (t.length > 100) return t.replace(/\n{3,}/g, '\n\n');
    }
  }
  return (doc.body.innerText || doc.body.textContent || '').trim();
}

// ─────────────────────────────────────────────────────────
//  文本输入
// ─────────────────────────────────────────────────────────
function setupTextInput() {
  $('text-input').addEventListener('input', e => {
    S.content  = e.target.value;
    S.fileName = '';
    $('char-count').textContent = `${fmtNum(S.content.length)} 字`;
    updateGenBtn();
  });
}

// ─────────────────────────────────────────────────────────
//  API 模式切换
// ─────────────────────────────────────────────────────────
function setupApiToggle() {
  $('mode-platform').addEventListener('click', () => {
    S.useCustom = false;
    $('mode-platform').classList.add('active');
    $('mode-custom').classList.remove('active');
    show('panel-platform');
    hide('panel-custom');
    updateGenBtn();
  });

  $('mode-custom').addEventListener('click', () => {
    S.useCustom = true;
    $('mode-custom').classList.add('active');
    $('mode-platform').classList.remove('active');
    hide('panel-platform');
    show('panel-custom');
    updateGenBtn();
  });

  ['custom-key', 'custom-url', 'custom-model'].forEach(id =>
    $(id).addEventListener('input', () => { saveCustomApi(); updateGenBtn(); })
  );

  document.querySelectorAll('input[name="api-fmt"]').forEach(r =>
    r.addEventListener('change', e => { S.customFmt = e.target.value; saveCustomApi(); })
  );
}

// ─────────────────────────────────────────────────────────
//  按钮绑定
// ─────────────────────────────────────────────────────────
function setupButtons() {
  $('generate-btn').addEventListener('click',      startGeneration);
  $('cancel-btn').addEventListener('click',        cancelGeneration);
  $('download-btn').addEventListener('click',      downloadResult);
  $('download-zip-btn').addEventListener('click',  downloadZip);
  $('restart-btn').addEventListener('click',       () => switchSection('input'));
  $('new-btn').addEventListener('click',           resetAll);
  $('preview-toggle').addEventListener('click',    togglePreview);

  // Logo 点击 → 取消进行中的生成，返回首页（保留已填内容）
  const logoEl = $('logo-home');
  const goHome = () => {
    if (S.generating) cancelGeneration();
    else switchSection('input');
  };
  logoEl.addEventListener('click', goHome);
  logoEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') goHome(); });
}

// ─────────────────────────────────────────────────────────
//  生成按钮可用性
// ─────────────────────────────────────────────────────────
function updateGenBtn() {
  const hasContent = activeContent().length > 0;
  const hasModel   = S.useCustom
    ? $('custom-key').value.trim() && $('custom-model').value.trim()
    : !!S.selectedModel;
  $('generate-btn').disabled = !(hasContent && hasModel);
}

function activeContent() {
  const tab = qs('.tab.active')?.dataset.tab;
  if (tab === 'text') return $('text-input').value.trim();
  return S.content;
}

// ─────────────────────────────────────────────────────────
//  主生成流程
// ─────────────────────────────────────────────────────────
async function startGeneration() {
  if (S.isRunning) return;
  S.isRunning = true;
  S.aborted   = false;

  switchSection('progress');
  setStep('extract', 'active');
  setStep('generate', 'pending');
  setStep('package',  'pending');

  try {
    // ── Step 1: 取内容 ──
    const rawContent = activeContent();
    if (!rawContent) throw new Error('内容为空，请先输入或上传文件');
    setStep('extract', 'done');
    setStep('generate', 'active');

    // ── Step 2: LLM 生成 ──
    const skillData = await runGeneration(rawContent);
    if (S.aborted) return;

    setStep('generate', 'done');
    setStep('package', 'active');

    // ── Step 3: 打包 ──
    const blob = await packSkill(skillData);
    setStep('package', 'done');

    // ── 展示结果 ──
    S.resultBlob = blob;
    S.resultName = skillData.skill_name || 'my-skill';
    renderResult(skillData, blob);
    clearUploadedContent();   // 生成完成后立即清除上传内容
    switchSection('result');

  } catch (e) {
    if (!S.aborted) {
      setStep('generate', 'error');
      if (e.message === '__PLATFORM_QUOTA__') {
        await sleep(600);
        switchSection('input');
        showQuotaAlert();
      } else {
        toast('生成失败：' + e.message, 'error');
        await sleep(1800);
        switchSection('input');
      }
    }
  } finally {
    S.isRunning = false;
    stopCountdown();
  }
}

function cancelGeneration() {
  S.aborted = true;
  stopCountdown();
  resetAll();
}

// ── 自定义 API 配置持久化（localStorage）────────────────────
const CUSTOM_API_KEY = 'easyskills_custom_api';

function saveCustomApi() {
  const cfg = {
    key:   $('custom-key').value.trim(),
    url:   $('custom-url').value.trim(),
    model: $('custom-model').value.trim(),
    fmt:   S.customFmt,
  };
  // 三项全空时删除记录，否则保存
  if (!cfg.key && !cfg.url && !cfg.model) {
    localStorage.removeItem(CUSTOM_API_KEY);
  } else {
    localStorage.setItem(CUSTOM_API_KEY, JSON.stringify(cfg));
  }
}

function loadCustomApi() {
  let cfg;
  try { cfg = JSON.parse(localStorage.getItem(CUSTOM_API_KEY) || 'null'); } catch {}
  if (!cfg) return;

  if (cfg.key)   $('custom-key').value   = cfg.key;
  if (cfg.url)   $('custom-url').value   = cfg.url;
  if (cfg.model) $('custom-model').value = cfg.model;
  if (cfg.fmt) {
    S.customFmt = cfg.fmt;
    const radio = document.querySelector(`input[name="api-fmt"][value="${cfg.fmt}"]`);
    if (radio) radio.checked = true;
  }

  // 有已保存的配置 → 自动展开自定义 API 面板
  if (cfg.key || cfg.model) {
    S.useCustom = true;
    $('mode-custom').classList.add('active');
    $('mode-platform').classList.remove('active');
    hide('panel-platform');
    show('panel-custom');
  }
}

// 平台模型调用上限提示：展示 banner 并自动切换到「自定义 API」模式
function showQuotaAlert() {
  // 显示提示 banner
  const el = $('quota-alert');
  if (el) el.classList.remove('hidden');

  // 自动切换到自定义 API 面板
  S.useCustom = true;
  $('mode-custom').classList.add('active');
  $('mode-platform').classList.remove('active');
  hide('panel-platform');
  show('panel-custom');
  updateGenBtn();

  // 滚动到模型选择卡片
  const card = $('mode-custom').closest('.card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─────────────────────────────────────────────────────────
//  LLM 调用
// ─────────────────────────────────────────────────────────
async function runGeneration(rawContent) {
  const userDesc   = $('skill-desc').value.trim();
  const customName = $('skill-name').value.trim();

  // 截断给 LLM 的内容
  const forLLM = rawContent.length > MAX_LLM_CHARS
    ? rawContent.slice(0, MAX_LLM_CHARS) + '\n\n[注：内容较长，以下为前 40000 字符]'
    : rawContent;

  const prompt  = buildPrompt(forLLM, userDesc, customName);
  const apiConf = getApiConf();
  const payload = buildPayload(prompt, apiConf);

  const raw = await callWithRetry(payload, apiConf);
  const txt = extractText(raw, apiConf.format);
  const dat = parseJSON(txt);

  // 补全字段
  if (!dat.skill_name)  dat.skill_name = customName || 'my-skill';
  if (!dat.skill_md)    throw new Error('AI 未返回有效的 SKILL.md 内容，请重试');
  if (!dat.reference_files) dat.reference_files = [];

  // 如果原始内容足够长，确保 references/content.md 存在（保存完整原文）
  const hasRef = dat.reference_files.some(f => f.path === 'references/content.md');
  if (!hasRef && rawContent.length > 500) {
    const refText = rawContent.length > MAX_REF_CHARS
      ? rawContent.slice(0, MAX_REF_CHARS) + '\n\n[内容过长，仅保存前 120000 字符]'
      : rawContent;
    dat.reference_files.push({ path: 'references/content.md', content: refText });
  }

  return dat;
}

// ─────────────────────────────────────────────────────────
//  Prompt 构建
// ─────────────────────────────────────────────────────────
function buildPrompt(content, userDesc, customName) {
  const nameLine = customName ? `\n  用户指定名称：${customName}` : '';
  const descLine = userDesc   ? `\n用户补充说明：${userDesc}\n`   : '';

  return `你是一位专业的 Claude Code / OpenClaw / Cursor / OpenCode Skill 创作专家。

Skill 是面向 **AI Agent** 的结构化知识与工作流包，核心文件是 SKILL.md。你需要根据提供的内容，生成一个高质量、可直接使用的 Skill。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 一、SKILL.md 结构要求（必须完整）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 1. YAML Frontmatter（必填字段）
\`\`\`yaml
---
name: kebab-case-skill-name${nameLine}
version: "1.0.0"
description: |
  [50-180字，动词开头，3句以内，用(1)(2)(3)枚举核心功能点。
   示例：Query stock daily/minute bars and financial metrics via API. Features:
   (1) Real-time price queries (2) Historical data retrieval (3) Financial ratios]
categories:
  - [primary-category]   # 如：knowledge / workflow / api / tool / analysis
tags:
  - [tag1]
  - [tag2]
---
\`\`\`

**description 写法要点**：
- 用动词开头（Monitor、Query、Control、Generate、Analyze 等）
- 列举 2-4 个具体功能点（用 (1)(2)(3) 编号）
- 包含关键触发词（用户会说什么话来激活这个skill）
- 禁止用"This skill"自指，禁止写使用说明（那是正文的事）

### 2. SKILL.md 正文结构（按以下章节顺序）

#### 必须包含的章节：

**## Overview**
2-3 句话说明此 Skill 解决什么问题、适用场景、核心价值。面向 Agent 而非用户。

**## Core Capabilities**
用列表枚举 3-8 个核心能力点。每条 1 句话，具体而非抽象。

**## Workflow**
Agent 使用此 Skill 时的完整工作流程。用编号步骤（1→2→3），包含：
- 何时触发（用户说了什么）
- 读取哪些参考文件（如 \`references/content.md\`）
- 如何处理和组织信息
- 如何输出给用户

**## Critical Rules**（关键约束，Agent 必须遵守）
用加粗或列表列出 3-6 条强制约束。示例：
- **必须**先读取 \`references/content.md\` 再回答，禁止凭记忆回答
- **禁止**超出 Skill 覆盖范围的话题
- **始终**提供信息来源或依据

**## Key Knowledge**（或 Key Concepts / Reference Guide）
核心知识的结构化摘要（重要术语、分类、对照表等）。
内容较长时拆分为子章节。详细内容通过 \`references/content.md\` 引用。

**## Error Handling**（如适用）
常见错误情况及处理策略：
- 信息不足时如何引导用户补充
- 超出知识范围时如何诚实告知
- 歧义问题如何澄清

**## References**（可选）
指向 references/ 目录中的详细文件列表及说明。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 二、写作原则
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. **面向 Agent**：写给 AI 执行，不是写给人类阅读的文档。用祈使句："读取文件"而非"你应该读取文件"
2. **约束优先**：Critical Rules 要明确、严格，防止 Agent 越权或幻觉
3. **信息密度高**：用表格、列表、编号，避免长段落。每条信息都有存在价值
4. **可操作性强**：告诉 Agent 具体怎么做，不要模糊的"参考相关内容"
5. **结构清晰**：章节层次分明，Agent 能快速定位所需指令
6. **references/ 用法**：详细的知识内容放在 references/content.md，SKILL.md 只保留结构和指令

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 三、输出格式
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

只返回合法 JSON，不加 markdown 代码块，不加其他文字：

{
  "skill_name": "kebab-case-name",
  "skill_md": "完整的 SKILL.md 内容（含 YAML frontmatter，内容要丰富完整）",
  "reference_files": [
    {"path": "references/content.md", "content": "详细整理后的知识内容，结构清晰，供 Skill.md 引用"}
  ],
  "summary": "一句话描述这个 Skill 的用途（20字以内）"
}
${descLine}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 四、待转换内容
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${content}
`;
}

// ─────────────────────────────────────────────────────────
//  API 配置 & Payload 构建
// ─────────────────────────────────────────────────────────
function getApiConf() {
  if (S.useCustom) {
    return {
      use_custom_api: true,
      api_key:  $('custom-key').value.trim(),
      base_url: $('custom-url').value.trim(),
      format:   S.customFmt,
      model:    $('custom-model').value.trim(),
    };
  }
  return {
    use_custom_api: false,
    format: S.selectedModel.format,
    model:  S.selectedModel.id,
  };
}

function buildPayload(prompt, apiConf) {
  const base = {
    model:      apiConf.model,
    max_tokens: 16000,
    messages:   [{ role: 'user', content: prompt }],
  };
  // OpenAI：强制 JSON 输出（模型支持时）
  if (apiConf.format === 'openai') {
    base.response_format = { type: 'json_object' };
  }
  return base;
}

// ─────────────────────────────────────────────────────────
//  带重试的 API 调用（队列控制）
// ─────────────────────────────────────────────────────────
async function callWithRetry(payload, apiConf) {
  const isPlatform = !apiConf.use_custom_api;
  let netErrCount  = 0;   // 累计网络错误次数（不含 503 队列等待）

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (S.aborted) throw new Error('已取消');

    try {
      const body = { payload, ...apiConf };
      const r = await fetch(`${PROXY}?action=generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (r.status === 503) {
        showQueueBox(attempt + 1);
        await countdown(RETRY_SECS);
        hideQueueBox();
        continue;
      }

      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `请求失败 (HTTP ${r.status})`);
      }

      return await r.json();

    } catch (e) {
      if (S.aborted) throw new Error('已取消');
      if (e.message.includes('已取消')) throw e;

      netErrCount++;

      // 平台模型：连续网络错误超出阈值 → 停止重试，提示用户切换自定义 API
      if (isPlatform && netErrCount >= PLATFORM_NET_RETRIES) {
        throw new Error('__PLATFORM_QUOTA__');
      }

      if (attempt < MAX_RETRIES) {
        const tip = isPlatform
          ? `网络异常，自动重试（${netErrCount}/${PLATFORM_NET_RETRIES}）…`
          : `网络异常，自动重试…`;
        showQueueBox(attempt + 1, tip);
        await countdown(RETRY_SECS);
        hideQueueBox();
        continue;
      }
      throw e;
    }
  }
  throw new Error('等待超时，请稍后重试');
}

function showQueueBox(attempt, customTitle) {
  $('queue-title').textContent  = customTitle || '服务繁忙，正在排队等待…';
  $('queue-detail').textContent = `第 ${attempt} 次等待，将在 ${RETRY_SECS} 秒后自动重试`;
  show('queue-box');
}
function hideQueueBox() { hide('queue-box'); }

function countdown(seconds) {
  return new Promise(resolve => {
    let remaining = seconds;
    $('queue-countdown').textContent = `${remaining}s`;
    stopCountdown();
    S.countdownTimer = setInterval(() => {
      if (S.aborted) { stopCountdown(); resolve(); return; }
      remaining--;
      $('queue-countdown').textContent = `${remaining}s`;
      if (remaining <= 0) { stopCountdown(); resolve(); }
    }, 1000);
  });
}

function stopCountdown() {
  if (S.countdownTimer) {
    clearInterval(S.countdownTimer);
    S.countdownTimer = null;
  }
}

// ─────────────────────────────────────────────────────────
//  响应解析
// ─────────────────────────────────────────────────────────
function extractText(resp, format) {
  if (format === 'anthropic') {
    return resp?.content?.[0]?.text || '';
  }
  return resp?.choices?.[0]?.message?.content || '';
}

function parseJSON(text) {
  if (!text) throw new Error('AI 返回了空响应');

  // 直接解析
  try { return JSON.parse(text); } catch {}

  // 去除 markdown 代码块
  const stripped = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch {}

  // 截取第一个 { ... }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  }

  throw new Error('无法解析 AI 返回的 JSON，请重试');
}

// ─────────────────────────────────────────────────────────
//  打包 .skill 文件（JSZip）
// ─────────────────────────────────────────────────────────
async function packSkill(dat) {
  if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载，请刷新页面');
  const zip    = new JSZip();
  const name   = dat.skill_name || 'my-skill';
  const folder = zip.folder(name);

  folder.file('SKILL.md', dat.skill_md);

  for (const rf of (dat.reference_files || [])) {
    // 确保路径安全（防止目录穿越）
    const safePath = rf.path.replace(/\.\.\//g, '').replace(/^\//, '');
    folder.file(safePath, rf.content || '');
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ─────────────────────────────────────────────────────────
//  结果渲染 & 下载
// ─────────────────────────────────────────────────────────
function renderResult(dat, blob) {
  const name = dat.skill_name || 'my-skill';
  $('result-title').textContent   = name;
  $('result-summary').textContent = dat.summary || '技能已生成';
  $('result-fname').textContent   = `${name}.skill`;
  $('result-fsize').textContent   = formatBytes(blob.size);
  $('preview-content').textContent = dat.skill_md || '';
  // 折叠预览
  $('preview-content').classList.add('hidden');
  $('preview-toggle').innerHTML = '▶ 预览 SKILL.md 内容';
}

function downloadResult() {
  if (!S.resultBlob) return;
  triggerDownload(S.resultBlob, `${S.resultName}.skill`);
}

// 下载通用 .zip（与 .skill 内容相同，文件名后缀不同）
// 适用于 OpenCode / Cursor / Codex / OpenClaw 等 agent 工具
function downloadZip() {
  if (!S.resultBlob) return;
  triggerDownload(S.resultBlob, `${S.resultName}.zip`);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function togglePreview() {
  const pre = $('preview-content');
  const btn = $('preview-toggle');
  if (pre.classList.contains('hidden')) {
    pre.classList.remove('hidden');
    btn.innerHTML = '▼ 隐藏 SKILL.md 内容';
  } else {
    pre.classList.add('hidden');
    btn.innerHTML = '▶ 预览 SKILL.md 内容';
  }
}

// ─────────────────────────────────────────────────────────
//  页面区域切换
// ─────────────────────────────────────────────────────────
function switchSection(name) {
  hide('section-input');
  hide('section-progress');
  hide('section-result');
  show(`section-${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 生成完成后清除上传内容（释放浏览器内存，保护用户隐私）
function clearUploadedContent() {
  // 清除内存中的原始文本
  S.content  = '';
  S.fileName = '';

  // 重置文件输入框（释放 File 对象引用）
  const fi = $('file-input');
  if (fi) fi.value = '';

  // 重置文件展示 UI
  hide('file-selected');
  hide('upload-parsing');
  show('drop-inner');
  setParseStatus('file', '');

  // 清除 URL 输入
  const ui = $('url-input');
  if (ui) ui.value = '';
  setParseStatus('url', '');

  // 清除文本输入
  const ti = $('text-input');
  if (ti) ti.value = '';
  $('char-count').textContent = '0 字';
}

function resetAll() {
  S.isRunning = false;
  S.aborted   = false;
  S.content   = '';
  S.fileName  = '';
  S.resultBlob = null;
  S.resultName = '';
  stopCountdown();

  // 重置表单
  $('file-input').value = '';
  hide('file-selected');
  show('drop-inner');
  setParseStatus('file', '');

  $('url-input').value = '';
  setParseStatus('url', '');

  $('text-input').value = '';
  $('char-count').textContent = '0 字';

  $('skill-name').value = '';
  $('skill-desc').value = '';

  hide('queue-box');
  const qa = $('quota-alert');
  if (qa) qa.classList.add('hidden');

  switchSection('input');
  updateGenBtn();
}

// ─────────────────────────────────────────────────────────
//  步骤指示器
// ─────────────────────────────────────────────────────────
function setStep(id, state) {
  // state: 'pending' | 'active' | 'done' | 'error'
  $(`step-${id}`).className = `step ${state}`;
}

// ─────────────────────────────────────────────────────────
//  解析状态提示
// ─────────────────────────────────────────────────────────
function setParseStatus(tab, msg, type = '') {
  const el = $(`${tab}-parse-status`) || $(`${tab}-status`);
  if (!el) return;
  if (!msg) { el.className = 'parse-status hidden'; return; }
  el.textContent = msg;
  el.className   = `parse-status ${type}`;
  el.classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────
//  Toast 消息
// ─────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, type = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show toast-${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3800);
}

// ─────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtNum(n) {
  return n.toLocaleString('zh-CN');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
