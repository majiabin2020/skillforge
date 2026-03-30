# EasySkills

[中文说明](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](./LICENSE)
[![PHP](https://img.shields.io/badge/PHP-7.4%2B-FF5C1A.svg)](https://www.php.net/)
[![Status](https://img.shields.io/badge/Status-Open%20Source-success.svg)](https://github.com/majiabin2020/skillforge)
[![Contributions Welcome](https://img.shields.io/badge/Contributions-Welcome-ff8a44.svg)](./CONTRIBUTING.md)

![EasySkills Cover](./assets/cover.svg)

EasySkills is an online Skill generator for AI agent ecosystems. It lets users upload documents, fetch web pages, or paste plain text, then turns that content into installable Skill packages with a generated `SKILL.md` and downloadable `.skill` or `.zip` output.

The project uses a lightweight frontend + PHP proxy architecture, making it suitable for shared hosting, BT Panel deployments, and simple PHP web environments. For scanned PDFs, it also includes a local OCR workflow based on Tesseract.js.

## Product Screenshot

![EasySkills Homepage](./assets/screenshots/homepage.png)

## Highlights

- Three input modes: file upload, web page fetch, and pasted text
- Supports `PDF`, `DOCX / DOC`, `TXT`, and `Markdown`
- Extracts text from normal PDFs and falls back to OCR for scanned PDFs
- Supports both platform-managed models and custom OpenAI-compatible / Anthropic APIs
- Automatically packages generated output into a standard Skill folder structure
- Includes queue retry, concurrency control, timeout cleanup, and basic SSRF protection
- No frontend build tool required

## Use Cases

- Turn manuals, courses, and tutorials into reusable agent Skills
- Convert internal SOPs and knowledge base content into structured agent instructions
- Transform web articles and product docs into installable Skill packages
- Generate Skill bundles for OpenClaw, OpenCode, Codex, Cursor, and similar tools

## How It Works

1. Users provide source content through file upload, URL fetch, or pasted text
2. The browser extracts and normalizes the content
3. Long text is trimmed and embedded into a structured Skill-generation prompt
4. `proxy.php` forwards the request to either a platform model or a custom model endpoint
5. The returned JSON is parsed into `SKILL.md` and optional reference files
6. JSZip packages the result into `.skill` and `.zip`
7. The UI shows a preview and download actions

## Tech Stack

### Frontend

- `index.html`: single-page structure
- `app.js`: parsing, OCR, model calls, and packaging logic
- `style.css`: UI styling and responsive layout

### Backend

- `proxy.php`: model proxy, web fetch, concurrency control, and request forwarding
- `setup.php`: downloads runtime libraries into `lib/`
- `tasks/`: file-based runtime markers for active requests

### Runtime Libraries

- `mammoth`
- `jszip`
- `pdfjs-dist`
- `tesseract.js`
- `chi_sim` and `eng` OCR language packs

## Project Structure

```text
skillforge/
├─ index.html
├─ app.js
├─ style.css
├─ proxy.php
├─ setup.php
├─ .htaccess
├─ tasks/
│  └─ .htaccess
└─ lib/              # generated after running setup.php
```

## Requirements

- PHP 7.4+
- `curl` enabled
- `mbstring` recommended
- Apache or Nginx
- Write access for `tasks/` and `lib/`

## Quick Start

### 1. Upload the project

Place the project in your web root.

### 2. Configure the platform model

Edit the constants at the top of `proxy.php`:

```php
define('PLATFORM_API_KEY',    'YOUR_API_KEY_HERE');
define('PLATFORM_BASE_URL',   'https://api.anthropic.com');
define('PLATFORM_API_FORMAT', 'anthropic'); // 'openai' or 'anthropic'
define('MAX_CONCURRENT',      3);
define('TASK_TIMEOUT_SEC',    600);
```

You can also customize the model list exposed to the frontend in `$PLATFORM_MODELS`.

### 3. Install runtime dependencies

Open:

```text
https://your-domain/setup.php
```

This downloads the required frontend libraries into `lib/`.

### 4. Set permissions

Make sure these paths are writable:

- `tasks/`
- `lib/`
- `lib/tessdata/`

### 5. Disable the installer

After setup is complete, delete or rename `setup.php`.

## Web Server Notes

### Apache

The repository already includes `.htaccess` files for basic security headers and to block direct access to runtime task files.

### Nginx

If `gzip_static` is enabled, `.traineddata.gz` files may be auto-decompressed by the server, which can break Tesseract.js OCR. Disable gzip for that path if needed:

```nginx
location ~* \.traineddata\.gz$ {
    gzip        off;
    gzip_static off;
    default_type application/octet-stream;
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Private-Network true;
}
```

## Security Notes

- API keys are stored on the server side in `proxy.php`
- URL fetching includes basic SSRF filtering for private and local hosts
- Archive packaging sanitizes file paths to reduce path traversal risk
- Runtime task files are protected by `tasks/.htaccess`

Production recommendations:

- Re-enable strict SSL verification
- Restrict CORS if the site is not meant for public cross-origin use
- Do not leave `setup.php` publicly accessible long-term

## Limitations

- No automated test suite yet
- File-based concurrency control is suitable for lightweight deployments, not large-scale clusters
- Generic web-page extraction may fail on complex sites
- Unstable model JSON output can still cause generation failures

## Roadmap Ideas

- Admin configuration panel
- Generation history
- More input formats such as EPUB and image batches
- Multi-language UI
- Stronger backend security and logging

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Contributor

- `majiabin2020`

## License

Released under the [MIT License](./LICENSE).
