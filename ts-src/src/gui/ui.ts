/**
 * Single-page HTML GUI for Youdao Note browser.
 * Served as an inline string to avoid external file dependencies.
 */

function getStyles(): string {
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f5f5f5; color: #333; }
  #app { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px;
             background: #fff; padding: 10px 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .toolbar label { font-size: 13px; color: #666; }
  .toolbar .path { flex: 1; font-size: 14px; padding: 4px 8px; background: #f9f9f9;
                   border: 1px solid #e0e0e0; border-radius: 4px; min-width: 200px;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-bar { display: flex; gap: 8px; margin-bottom: 12px; }
  .search-bar input { flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px;
                      font-size: 14px; outline: none; }
  .search-bar input:focus { border-color: #4a90d9; }
  button { padding: 6px 16px; border: 1px solid #ddd; border-radius: 6px; background: #fff;
           cursor: pointer; font-size: 13px; transition: all .15s; }
  button:hover { background: #f0f0f0; border-color: #bbb; }
  button.primary { background: #4a90d9; color: #fff; border-color: #4a90d9; }
  button.primary:hover { background: #357abd; }
  .file-list { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; font-size: 12px; color: #888;
       text-transform: uppercase; letter-spacing: .5px; border-bottom: 2px solid #f0f0f0; background: #fafafa; }
  td { padding: 8px 12px; font-size: 14px; border-bottom: 1px solid #f5f5f5; }
  tr:hover td { background: #f8fafc; }
  tr.dir td { cursor: pointer; }
  tr.dir td:first-child::before { content: "📁 "; }
  tr.file td:first-child::before { content: "📄 "; }
  .actions { display: flex; gap: 6px; }
  .status-bar { margin-top: 12px; padding: 10px 16px; background: #fff; border-radius: 8px;
                box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; color: #666;
                display: flex; justify-content: space-between; align-items: center; }
  .loading { text-align: center; padding: 40px; color: #999; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .ctx-menu { position: fixed; background: #fff; border: 1px solid #ddd; border-radius: 6px;
              box-shadow: 0 4px 12px rgba(0,0,0,.15); z-index: 100; min-width: 140px; display: none; }
  .ctx-menu div { padding: 8px 16px; cursor: pointer; font-size: 13px; }
  .ctx-menu div:hover { background: #f0f4ff; }`;
}

function getScriptInit(): string {
  return `
var S = { path: '/', dirStack: [], entries: [], sel: null, dlDir: '' };
function api(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function(r) { return r.json(); }).then(function(d) { if (d.error) throw new Error(d.error); return d; });
}
function $(id) { return document.getElementById(id); }
function setStatus(m) { $('status').textContent = m; }
function showLoading(v) { $('loading').style.display = v ? '' : 'none'; }
function showEmpty(v) { $('empty').style.display = v ? '' : 'none'; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }`;
}

function getScriptRender(): string {
  return `
function renderEntries(folders, files) {
  S.entries = folders.concat(files);
  var tb = $('fileBody'); tb.innerHTML = ''; showEmpty(S.entries.length === 0);
  S.entries.forEach(function(e) {
    var tr = document.createElement('tr'); tr.className = e.isDir ? 'dir' : 'file';
    var btn = e.isDir
      ? '<button onclick="enterDir(\\'' + esc(e.id) + '\\',\\'' + esc(e.name) + '\\')">Open</button>'
      : '<button class="primary" onclick="dl(\\'' + esc(e.id) + '\\',\\'' + esc(e.name) + '\\')">Download</button>';
    tr.innerHTML = '<td>'+esc(e.name)+'</td><td>'+(e.isDir?'Folder':'File')+'</td><td>'+esc(e.sizeStr)+'</td><td>'+esc(e.timeStr)+'</td><td class="actions">'+btn+'</td>';
    tr.addEventListener('contextmenu', function(ev) { ev.preventDefault(); showCtx(ev, e); });
    if (e.isDir) tr.addEventListener('dblclick', function() { enterDir(e.id, e.name); });
    tb.appendChild(tr);
  });
}
function loadRoot() {
  showLoading(true);
  api('/api/root').then(function(d) {
    S.path = '/'; S.dirStack = [{ id: d.dirId, name: '/' }]; $('pathDisplay').textContent = '/';
    return loadDir(d.dirId);
  }).catch(function(e) { setStatus('Error: '+e.message); }).finally(function() { showLoading(false); });
}
function loadDir(dirId) {
  showLoading(true); setStatus('Loading...');
  return api('/api/dir', { dirId: dirId }).then(function(d) {
    renderEntries(d.folders, d.files);
    setStatus(d.folders.length + ' folders, ' + d.files.length + ' files');
  }).catch(function(e) { setStatus('Error: '+e.message); }).finally(function() { showLoading(false); });
}`;
}

function getScriptActions(): string {
  return `
function enterDir(id, name) {
  S.dirStack.push({ id: id, name: name });
  S.path = S.dirStack.map(function(d){return d.name;}).join('/').replace(/^\\/\\//,'/') || '/';
  $('pathDisplay').textContent = S.path; loadDir(id);
}
function goBack() {
  if (S.dirStack.length <= 1) return; S.dirStack.pop();
  var c = S.dirStack[S.dirStack.length - 1];
  S.path = S.dirStack.map(function(d){return d.name;}).join('/').replace(/^\\/\\//,'/') || '/';
  $('pathDisplay').textContent = S.path; loadDir(c.id);
}
function refresh() { if (S.dirStack.length) loadDir(S.dirStack[S.dirStack.length-1].id); }
function dl(fid, fn) {
  setStatus('Downloading: '+fn);
  api('/api/download', { fileId: fid, fileName: fn }).then(function(r) {
    setStatus('Downloaded: '+fn+' ('+r.type+')');
  }).catch(function(e) { setStatus('Download failed: '+e.message); });
}
function search() {
  var kw = $('searchInput').value.trim(); if (!kw) return;
  setStatus('Searching: '+kw+'...'); showLoading(true);
  api('/api/search', { keyword: kw }).then(function(r) {
    renderEntries(r.results.filter(function(x){return x.isDir;}), r.results.filter(function(x){return !x.isDir;}));
    setStatus('Search: '+r.results.length+' match(es)');
  }).catch(function(e) { setStatus('Search failed: '+e.message); }).finally(function() { showLoading(false); });
}
function showCtx(ev, entry) {
  S.sel = entry; var m = $('ctxMenu'); m.style.display='block'; m.style.left=ev.clientX+'px'; m.style.top=ev.clientY+'px';
}
document.addEventListener('click', function() { $('ctxMenu').style.display = 'none'; });
function downloadSelected() { if (S.sel) dl(S.sel.id, S.sel.name); }
function copyId() { if (S.sel) navigator.clipboard.writeText(S.sel.id); setStatus('Copied ID'); }
function copyPath() {
  if (S.sel) { navigator.clipboard.writeText((S.path==='/'?'/':S.path+'/')+S.sel.name); setStatus('Copied path'); }
}
api('/api/download-dir').then(function(d) { S.dlDir=d.dir; $('downloadDir').textContent='Download dir: '+d.dir; }).catch(function(){});
loadRoot();`;
}

export function getGuiHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Youdao Note Manager</title>
<style>${getStyles()}</style>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <label>Path:</label>
    <span class="path" id="pathDisplay">/</span>
    <button onclick="goBack()">⬆ Up</button>
    <button onclick="refresh()">🔄 Refresh</button>
  </div>
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search notes..." onkeydown="if(event.key==='Enter')search()">
    <button onclick="search()">Search</button>
  </div>
  <div class="file-list">
    <table>
      <thead>
        <tr><th style="width:40%">Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Actions</th></tr>
      </thead>
      <tbody id="fileBody"></tbody>
    </table>
    <div id="loading" class="loading" style="display:none">Loading...</div>
    <div id="empty" class="empty" style="display:none">No files found</div>
  </div>
  <div class="status-bar">
    <span id="status">Ready</span>
    <span id="downloadDir">Download dir: loading...</span>
  </div>
</div>
<div class="ctx-menu" id="ctxMenu">
  <div onclick="downloadSelected()">Download</div>
  <div onclick="copyId()">Copy ID</div>
  <div onclick="copyPath()">Copy Path</div>
</div>
<script>${getScriptInit()}${getScriptRender()}${getScriptActions()}</script>
</body>
</html>`;
}
