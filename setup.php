<?php
/**
 * EasySkills 依赖库本地化安装脚本
 *
 * 使用方法：在浏览器访问 https://你的域名/setup.php
 * 脚本会从网络下载所有前端依赖库到 lib/ 目录。
 * 完成后请删除或禁止访问此文件（安全起见）。
 */

set_time_limit(600);
ini_set('display_errors', 1);

$LIB_DIR = __DIR__ . '/lib';
if (!is_dir($LIB_DIR))              mkdir($LIB_DIR,               0755, true);
if (!is_dir($LIB_DIR . '/tessdata')) mkdir($LIB_DIR . '/tessdata', 0755, true);

// 需要下载的文件：[本地相对路径 => [候选 URL（按优先级尝试）]]
// 所有 URL 优先使用国内 npmmirror 镜像，CDN 仅作备用
$files = [

  // ── 基础库 ────────────────────────────────────────────────
  'mammoth.browser.min.js' => [
    'https://registry.npmmirror.com/mammoth/1.6.0/files/mammoth.browser.min.js',
    'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
  ],
  'jszip.min.js' => [
    'https://registry.npmmirror.com/jszip/3.10.1/files/dist/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  ],

  // ── PDF.js（文字层提取）────────────────────────────────────
  'pdf.min.js' => [
    'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.min.js',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  ],
  'pdf.worker.min.js' => [
    'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.worker.min.js',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  ],

  // ── Tesseract.js（扫描件 OCR）────────────────────────────
  'tesseract.min.js' => [
    'https://registry.npmmirror.com/tesseract.js/5.1.1/files/dist/tesseract.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  ],
  'tesseract.worker.min.js' => [
    'https://registry.npmmirror.com/tesseract.js/5.1.1/files/dist/worker.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  ],
  // Tesseract WASM 核心（~5 MB，含 SIMD 加速）
  'tesseract-core.wasm.js' => [
    'https://registry.npmmirror.com/tesseract.js-core/5.0.0/files/tesseract-core-simd-lstm.wasm.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.0.0/tesseract-core-simd-lstm.wasm.js',
  ],

  // ── Tesseract 语言包（扫描件识别必需）────────────────────
  // 注：npm 包内文件在包根目录，不含 tessdata/ 子目录；官方 CDN 作最终兜底
  // 中文简体（~10 MB）
  'tessdata/chi_sim.traineddata.gz' => [
    'https://registry.npmmirror.com/@tesseract.js-data/chi_sim/4.0.0/files/chi_sim.traineddata.gz',
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@4.0.0/chi_sim.traineddata.gz',
    'https://unpkg.com/@tesseract.js-data/chi_sim@4.0.0/chi_sim.traineddata.gz',
    'https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz',
  ],
  // 英文（~2 MB）
  'tessdata/eng.traineddata.gz' => [
    'https://registry.npmmirror.com/@tesseract.js-data/eng/4.0.0/files/eng.traineddata.gz',
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@4.0.0/eng.traineddata.gz',
    'https://unpkg.com/@tesseract.js-data/eng@4.0.0/eng.traineddata.gz',
    'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
  ],
];

// ── 核心下载函数 ──────────────────────────────────────────
function downloadFile(string $url, string $dest): array
{
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_TIMEOUT        => 300, // 语言包约 10 MB，给足下载时间
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_USERAGENT      => 'Mozilla/5.0',
    CURLOPT_ENCODING       => '',
  ]);
  $data = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $err  = curl_error($ch);
  curl_close($ch);

  if ($err || !$data || $code >= 400) {
    return ['ok' => false, 'msg' => $err ?: "HTTP {$code}"];
  }
  file_put_contents($dest, $data);
  return ['ok' => true, 'size' => strlen($data)];
}

function formatBytes(int $bytes): string
{
  if ($bytes >= 1048576) return round($bytes / 1048576, 1) . ' MB';
  if ($bytes >= 1024)    return round($bytes / 1024, 1) . ' KB';
  return $bytes . ' B';
}

// ── 执行下载 ──────────────────────────────────────────────
$results = [];
$allOk   = true;

foreach ($files as $name => $urls) {
  $dest   = $LIB_DIR . '/' . $name;
  $exists = file_exists($dest);
  $size   = $exists ? filesize($dest) : 0;

  // 已存在且大于 10KB 则跳过
  if ($exists && $size > 10240) {
    $results[$name] = ['status' => 'skip', 'msg' => '已存在，跳过', 'size' => $size];
    continue;
  }

  $tried = [];
  $done  = false;
  foreach ($urls as $url) {
    $r = downloadFile($url, $dest);
    if ($r['ok']) {
      $results[$name] = ['status' => 'ok', 'msg' => $url, 'size' => $r['size']];
      $done = true;
      break;
    }
    $tried[] = basename(parse_url($url, PHP_URL_HOST)) . ': ' . $r['msg'];
  }
  if (!$done) {
    $results[$name] = ['status' => 'fail', 'msg' => implode('；', $tried)];
    $allOk = false;
  }
}

// ── 为 Apache 用户自动创建 lib/tessdata/.htaccess ──────────
// Nginx gzip_static 会对 .gz 加 Content-Encoding 导致 Tesseract.js 卡死
// Apache 的 .htaccess 可在此修复；Nginx 需在站点配置中处理（见下方提示）
$htaccessPath = $LIB_DIR . '/tessdata/.htaccess';
if (!file_exists($htaccessPath)) {
    file_put_contents($htaccessPath,
        "# 禁止 Apache 将 .gz 文件当作 gzip 编码内容自动解压\n" .
        "# Tesseract.js 需要原始 gzip 字节流，自行负责解压\n" .
        "<IfModule mod_mime.c>\n" .
        "  RemoveEncoding .gz\n" .
        "  RemoveType .gz\n" .
        "  AddType application/octet-stream .gz\n" .
        "</IfModule>\n" .
        "<IfModule mod_headers.c>\n" .
        "  <FilesMatch \"\\.gz$\">\n" .
        "    Header unset Content-Encoding\n" .
        "  </FilesMatch>\n" .
        "</IfModule>\n"
    );
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>EasySkills 依赖安装</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#F2F2F2;color:#0A0A0A;padding:40px 20px}
    .wrap{max-width:640px;margin:0 auto}
    h1{font-size:20px;font-weight:800;margin-bottom:6px}
    p.sub{color:#737373;font-size:13px;margin-bottom:32px}
    .card{background:#fff;border:1px solid #E8E8E8;border-radius:14px;overflow:hidden;margin-bottom:16px}
    .row{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid #F0F0F0}
    .row:last-child{border-bottom:none}
    .name{font-size:13px;font-weight:600;flex:1;font-family:monospace}
    .badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px;white-space:nowrap}
    .ok  {background:#ECFDF5;color:#065F46}
    .skip{background:#F5F5F5;color:#737373}
    .fail{background:#FEF2F2;color:#991B1B}
    .size{font-size:11px;color:#9A9A9A;font-family:monospace;white-space:nowrap}
    .msg{font-size:11px;color:#9A9A9A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
    .summary{padding:20px;border-radius:14px;font-size:14px;font-weight:600;text-align:center}
    .summary.ok  {background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0}
    .summary.fail{background:#FEF2F2;color:#991B1B;border:1px solid #FECACA}
    .hint{margin-top:20px;background:#FFF4EF;border:1px solid #FFD4BF;border-radius:12px;padding:16px;font-size:13px;color:#7A2D0A;line-height:1.7}
    .hint code{background:rgba(255,92,26,.1);padding:1px 6px;border-radius:4px;font-family:monospace}
  </style>
</head>
<body>
<div class="wrap">
  <h1>⚡ EasySkills 依赖库安装</h1>
  <p class="sub">服务器正在从镜像源下载前端依赖库到 <code>lib/</code> 目录…</p>

  <div class="card">
    <?php foreach ($results as $name => $r): ?>
    <div class="row">
      <span class="name"><?= htmlspecialchars($name) ?></span>
      <?php if ($r['status'] === 'ok'): ?>
        <span class="badge ok">✓ 下载成功</span>
        <span class="size"><?= formatBytes($r['size']) ?></span>
      <?php elseif ($r['status'] === 'skip'): ?>
        <span class="badge skip">已存在</span>
        <span class="size"><?= formatBytes($r['size']) ?></span>
      <?php else: ?>
        <span class="badge fail">✗ 失败</span>
        <span class="msg" title="<?= htmlspecialchars($r['msg']) ?>"><?= htmlspecialchars($r['msg']) ?></span>
      <?php endif ?>
    </div>
    <?php endforeach ?>
  </div>

  <?php if ($allOk): ?>
  <div class="summary ok">✅ 全部依赖库已就绪，可以正常使用 EasySkills！</div>
  <?php else: ?>
  <div class="summary fail">⚠ 部分文件下载失败，请检查服务器网络，然后刷新本页重试</div>
  <?php endif ?>

  <div class="hint">
    💡 <strong>安全提示：</strong>安装完成后，请在宝塔面板将 <code>setup.php</code> 重命名或删除，避免被他人重复调用。<br><br>
    ℹ <strong>OCR 说明：</strong>扫描件 PDF 将自动使用本地 <strong>Tesseract.js</strong> 进行 OCR 识别（中英文），无需调用任何大模型接口，完全离线运行。
  </div>

  <div class="hint" style="margin-top:14px;background:#EFF6FF;border-color:#BFDBFE;color:#1E3A5F">
    ⚠ <strong>Nginx 用户必读（OCR 卡在 0% 的解决方法）：</strong><br><br>
    Nginx 的 <code>gzip_static</code> 功能会对 <code>.gz</code> 文件添加 <code>Content-Encoding: gzip</code> 响应头，导致浏览器自动解压后 Tesseract.js 收到明文数据卡死。<br><br>
    请在宝塔面板 → 网站 → 配置文件 中，找到 <code>server {}</code> 块内部，添加以下配置后保存并重启 Nginx：
    <br><br>
    <code style="display:block;background:#1E293B;color:#7DD3FC;padding:12px 16px;border-radius:8px;font-size:12px;line-height:1.8;white-space:pre">location ~* \.traineddata\.gz$ {
    gzip        off;
    gzip_static off;
    default_type application/octet-stream;
    add_header Access-Control-Allow-Origin        *;
    add_header Access-Control-Allow-Private-Network true;
}</code>
    <br>
    添加后重新访问本页，之后 OCR 识别将正常使用本地语言包（约 12 MB，首次加载需几秒）。<br>
    若暂时不方便改 Nginx 配置，程序会自动回退到在线 CDN 加载语言包，功能不受影响。
  </div>
</div>
</body>
</html>
