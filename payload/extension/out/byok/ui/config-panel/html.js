"use strict";

function escapeJsonForHtml(s) {
  return String(s ?? "").replace(/</g, "\\u003c");
}

function renderConfigPanelHtml({ vscode, webview, ctx, init }) {
  const cacheBust = String(Date.now().toString(16));
  const utilUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "util.js")) + `?v=${cacheBust}`;
  const renderUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "render", "index.js")) + `?v=${cacheBust}`;
  const renderProvidersUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "render", "providers.js")) + `?v=${cacheBust}`;
  const renderEndpointsUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "render", "endpoints.js")) + `?v=${cacheBust}`;
  const renderHistorySummaryUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "render", "history-summary.js")) +
    `?v=${cacheBust}`;
  const renderAppUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "render", "app.js")) + `?v=${cacheBust}`;
  const webviewDomUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "dom.js")) + `?v=${cacheBust}`;
  const webviewCoreUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "core.js")) + `?v=${cacheBust}`;
  const webviewHandlersUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "handlers.js")) + `?v=${cacheBust}`;
  const mainUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "webview", "main.js")) + `?v=${cacheBust}`;
  const styleUri =
    webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "byok", "ui", "config-panel", "style.css")) + `?v=${cacheBust}`;

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`
  ].join("; ");

  const initJson = escapeJsonForHtml(JSON.stringify(init || {}, null, 2));

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>BYOK Config</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <script id="byokInit" type="application/json">${initJson}</script>
  <div id="app"></div>
  <script src="${utilUri}"></script>
  <script src="${renderUri}"></script>
  <script src="${renderProvidersUri}"></script>
  <script src="${renderEndpointsUri}"></script>
  <script src="${renderHistorySummaryUri}"></script>
  <script src="${renderAppUri}"></script>
  <script src="${webviewDomUri}"></script>
  <script src="${webviewCoreUri}"></script>
  <script src="${webviewHandlersUri}"></script>
  <script src="${mainUri}"></script>
</body>
</html>`;
}

module.exports = { renderConfigPanelHtml };
