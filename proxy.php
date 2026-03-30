<?php
/**
 * SkillForge Proxy — API Gateway with Concurrency Control
 *
 * 宝塔部署说明：
 *  1. 将整个 skillforge/ 目录上传到网站根目录
 *  2. 修改下方「PLATFORM CONFIGURATION」区域中的值
 *  3. 确保 tasks/ 目录对 PHP 可写 (chmod 755 tasks/)
 *  4. 确认 PHP 已开启 curl 扩展（宝塔默认已开启）
 */

// ============================================================
//  PLATFORM CONFIGURATION（管理员修改此区域）
// ============================================================
define('PLATFORM_API_KEY',    'YOUR_API_KEY_HERE');         // 平台 API Key（不会暴露给前端）
define('PLATFORM_BASE_URL',   'https://api.anthropic.com'); // API 服务地址
define('PLATFORM_API_FORMAT', 'anthropic');                  // 'openai' 或 'anthropic'
define('MAX_CONCURRENT',      3);                            // 最大并发任务数
define('TASK_TIMEOUT_SEC',    600);                          // 任务文件最大存活时间（秒）

// 前端可选的平台模型（只暴露名称，不含 Key）
$PLATFORM_MODELS = [
    [
        'id'          => 'stepfun/step-3.5-flash:free',
        'name'        => 'stepfun/step-3.5-flash',
        'description' => '快速高效，推荐日常使用',
        'format'      => 'openai',
    ],
    [
        'id'          => 'qwen/qwen3-coder:free',
        'name'        => 'qwen/qwen3-coder',
        'description' => '适合复杂或编程、数学等专业内容',
        'format'      => 'openai',
    ],
];
// ============================================================

// CORS & 响应头
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

$action = $_GET['action'] ?? 'generate';

switch ($action) {
    case 'models':   handleModels();   break;
    case 'generate': handleGenerate(); break;
    case 'fetch':    handleFetch();    break;
    case 'status':   handleStatus();   break;
    default:
        jsonError('Unknown action', 400);
}

// ─────────────────────────────────────────
//  Action: models — 返回可用平台模型列表
// ─────────────────────────────────────────
function handleModels(): void
{
    global $PLATFORM_MODELS;
    echo json_encode(['models' => $PLATFORM_MODELS]);
}

// ─────────────────────────────────────────
//  Action: status — 返回当前并发状态
// ─────────────────────────────────────────
function handleStatus(): void
{
    $dir   = tasksDir();
    $count = countActiveTasks($dir);
    echo json_encode([
        'active'    => $count,
        'max'       => MAX_CONCURRENT,
        'available' => max(0, MAX_CONCURRENT - $count),
    ]);
}

// ─────────────────────────────────────────
//  Action: fetch — 代理抓取网页内容
// ─────────────────────────────────────────
function handleFetch(): void
{
    $url = trim($_GET['url'] ?? '');
    if (!$url) {
        jsonError('URL required', 400);
        return;
    }

    // SSRF 防护
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host || isPrivateHost($host)) {
        jsonError('Access denied: private or invalid host', 403);
        return;
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER     => ['Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    ]);

    $html     = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $html === false) {
        jsonError('抓取失败：' . ($curlErr ?: '未知错误'), 502);
        return;
    }
    if ($httpCode >= 400) {
        jsonError("目标页面返回 HTTP {$httpCode}", 502);
        return;
    }

    // 统一编码为 UTF-8
    $encoding = mb_detect_encoding($html, ['UTF-8', 'GBK', 'GB2312', 'BIG5'], true);
    if ($encoding && $encoding !== 'UTF-8') {
        $html = mb_convert_encoding($html, 'UTF-8', $encoding);
    }

    echo json_encode(['html' => $html, 'status' => $httpCode]);
}

// ─────────────────────────────────────────
//  Action: generate — 并发控制 + 转发 LLM
// ─────────────────────────────────────────
function handleGenerate(): void
{
    $dir    = tasksDir();
    $taskId = uniqid('t_', true);

    cleanStaleTasks($dir);

    $active = countActiveTasks($dir);
    if ($active >= MAX_CONCURRENT) {
        http_response_code(503);
        echo json_encode([
            'error'   => 'queue_full',
            'active'  => $active,
            'max'     => MAX_CONCURRENT,
            'message' => '当前服务繁忙，请稍后重试',
        ]);
        return;
    }

    // 占用槽位
    $taskFile = $dir . '/active_' . $taskId . '.json';
    file_put_contents($taskFile, json_encode(['id' => $taskId, 'started' => time()]));

    $body = json_decode(file_get_contents('php://input'), true);
    if (!$body || empty($body['payload'])) {
        @unlink($taskFile);
        jsonError('Invalid request body', 400);
        return;
    }

    // 决定使用平台 Key 还是自定义 Key
    $useCustom = !empty($body['use_custom_api']);
    if ($useCustom) {
        $apiKey  = $body['api_key']  ?? '';
        $baseUrl = $body['base_url'] ?? PLATFORM_BASE_URL;
        $format  = $body['format']   ?? 'openai';
    } else {
        $apiKey  = PLATFORM_API_KEY;
        $baseUrl = PLATFORM_BASE_URL;
        $format  = $body['format']   ?? PLATFORM_API_FORMAT;
    }

    if (empty($baseUrl)) $baseUrl = ($format === 'anthropic')
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com';

    $result = callLLM($apiKey, $baseUrl, $format, $body['payload']);

    @unlink($taskFile);

    if ($result['ok']) {
        echo json_encode($result['data']);
    } else {
        http_response_code($result['code'] ?? 500);
        echo json_encode(['error' => $result['error']]);
    }
}

// ─────────────────────────────────────────
//  LLM 转发
// ─────────────────────────────────────────
function callLLM(string $key, string $base, string $format, array $payload): array
{
    if ($format === 'anthropic') {
        $url     = rtrim($base, '/') . '/v1/messages';
        $headers = [
            'Content-Type: application/json',
            'x-api-key: ' . $key,
            'anthropic-version: 2023-06-01',
        ];
    } else {
        $url     = rtrim($base, '/') . '/v1/chat/completions';
        $headers = [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $key,
        ];
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 300, // max_tokens=16000 时生成时间更长
        CURLOPT_SSL_VERIFYPEER => false,
    ]);

    $raw     = curl_exec($ch);
    $code    = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
        return ['ok' => false, 'error' => '连接错误：' . $curlErr, 'code' => 502];
    }

    $data = json_decode($raw, true);
    if ($code >= 400) {
        $msg = $data['error']['message'] ?? ($data['error'] ?? "API 返回 HTTP {$code}");
        return ['ok' => false, 'error' => $msg, 'code' => $code];
    }

    return ['ok' => true, 'data' => $data];
}

// ─────────────────────────────────────────
//  任务管理
// ─────────────────────────────────────────
function tasksDir(): string
{
    $dir = __DIR__ . '/tasks';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    return $dir;
}

function countActiveTasks(string $dir): int
{
    return count(glob($dir . '/active_*.json') ?: []);
}

function cleanStaleTasks(string $dir): void
{
    foreach (glob($dir . '/active_*.json') ?: [] as $f) {
        if ((time() - (int) filemtime($f)) > TASK_TIMEOUT_SEC) {
            @unlink($f);
        }
    }
}

// ─────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────
function isPrivateHost(string $host): bool
{
    $lower = strtolower($host);
    if (in_array($lower, ['localhost', '127.0.0.1', '::1'], true)) {
        return true;
    }
    $ip = gethostbyname($host);
    // 检查私有/保留地址
    return filter_var(
        $ip,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) === false;
}

function jsonError(string $msg, int $code = 500): void
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
}
