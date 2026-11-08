/**
 * 面板 HTML 骨架。样式与脚本是独立静态资源（`/assets/app.css`、`/assets/app.js`），
 * 页面本身零外链：没有 Google Fonts，没有 CDN，图标是内联 SVG。
 * @module antigravity-dashboard/ui
 */

// data URI 必须整体 URL 编码：直接把 SVG 原文塞进 src="" 会被内部双引号截断（图标裂开）。
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="8" fill="#141218"/>'
  + '<path d="M18 6 9 19h6l-2 7 9-13h-6z" fill="#D0BCFF"/>'
  + '</svg>'
const FAVICON = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`

/**
 * @param {{title?: string}} [options]
 * @returns {string} 完整 HTML
 */
export function dashboardHtml(options = {}) {
  const title = options.title ?? 'Antigravity 面板'
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="icon" href="${FAVICON}" />
<link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
<div class="app">
  <nav class="drawer">
    <div class="brand">
      <img class="brand-logo" alt="" src="${FAVICON}" />
      <span class="brand-name">Antigravity</span>
    </div>
    <a class="nav-item" href="#home" data-page="home" data-act="nav"><span class="nav-ic" data-ic="home"></span><span>首页</span></a>
    <a class="nav-item" href="#traffic" data-page="traffic" data-act="nav"><span class="nav-ic" data-ic="traffic"></span><span>请求</span></a>
    <a class="nav-item" href="#runtime" data-page="runtime" data-act="nav"><span class="nav-ic" data-ic="runtime"></span><span class="badge" id="badge-rt"></span><span>运行</span></a>
    <a class="nav-item" href="#settings" data-page="settings" data-act="nav"><span class="nav-ic" data-ic="settings"></span><span>设置</span></a>
    <div class="grow"></div>
    <div class="top-actions" style="display:flex;align-items:center;gap:4px;padding:8px 4px">
      <span class="chip t-plain"><span class="dot" id="sync-dot-top"></span><span id="sync-top">连接中</span></span>
      <button class="icon-btn" data-act="refresh" aria-label="刷新" data-ic="refresh"></button>
      <button class="icon-btn" data-act="theme" aria-label="切换主题"></button>
    </div>
  </nav>

  <main class="content">
    <header class="topbar">
      <h1 id="page-title" style="font-size:22px;font-weight:500;margin:0">首页</h1>
      <span class="grow"></span>
      <span class="chip t-plain"><span class="dot" id="sync-dot"></span><span id="sync">连接中</span></span>
      <button class="icon-btn" data-act="refresh" aria-label="刷新" data-ic="refresh"></button>
      <button class="icon-btn" data-act="theme" aria-label="切换主题"></button>
    </header>
    <div class="wrap" id="page-body" style="display:flex;flex-direction:column;gap:16px"></div>
    <div class="snack" id="snack"></div>
  </main>
</div>
<script src="/assets/app.js"></script>
</body>
</html>
`
}
