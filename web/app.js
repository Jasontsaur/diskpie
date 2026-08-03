/* DiskPie 前端：圓餅圖 + 明細表格 + 逐層展開 */
(() => {
  'use strict';

  // ---------- 幾何常數（viewBox 為 420 x 360） ----------
  const CX = 210, CY = 180, R_OUT = 130, R_IN = 80, R_LABEL = 150;
  const PIE_ITEMS = 15;         // 圓餅實際畫幾塊，之後才併成「其他」
  const SLOTS = 8;              // 通過色盲驗證的類別色數量；第 9 名起改用灰階
  const TAIL = 8;               // 灰階階數（第 9～15 名各一階，最後一階給「其他」）
  const LABEL_MIN = 0.07;       // 佔比達 7% 才在圖上直接標示
  const NAME_MIN = 0.12;        // 佔比達 12% 才連名稱一起標
  const MAX_ROWS = 300;         // 表格先顯示前 N 列

  const $ = (id) => document.getElementById(id);
  const el = {
    driveSelect: $('drive-select'), pathInput: $('path-input'),
    scanBtn: $('scan-btn'), cancelBtn: $('cancel-btn'), themeBtn: $('theme-btn'),
    status: $('status'), statusTitle: $('status-title'),
    statusNumbers: $('status-numbers'), statusCurrent: $('status-current'),
    main: $('main'), empty: $('empty'), breadcrumb: $('breadcrumb'),
    chartTitle: $('chart-title'), slices: $('slices'), sliceLabels: $('slice-labels'),
    centerLabel: $('center-label'), centerValue: $('center-value'), centerSub: $('center-sub'),
    tooltip: $('tooltip'), chartWrap: document.querySelector('.chart-wrap'),
    tbody: $('tbody'), filesBlock: $('files-block'), filesCount: $('files-count'),
    filesTbody: $('files-tbody'),
    upBtn: $('up-btn'), rootBtn: $('root-btn'), openBtn: $('open-btn'), rescanBtn: $('rescan-btn'),
  };

  let token = '';
  let view = null;        // 目前這一層的資料
  let items = [];         // 目前這一層的所有項目（表格用，已排序）
  let segments = [];      // 目前圓餅的分段（前 8 名 + 其他）
  let poller = null;
  let showAllRows = false;

  // ---------- 小工具 ----------

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return s + ' ' + units[i];
  }

  const fmtInt = (n) => (n || 0).toLocaleString('zh-Hant');
  const fmtPct = (p) => (p >= 0.1 ? p.toFixed(1) : p.toFixed(2)) + '%';

  function ellipsis(text, max) {
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
  }

  /* 每次重繪時把整組配色讀出來一次就好（getComputedStyle 很貴，項目可能上千筆）。
     前 SLOTS 名用類別色；第 9～15 名用灰階，深淺代表名次；第 16 名之後全部同一階。 */
  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const get = (n) => css.getPropertyValue(n).trim();
    return {
      series: Array.from({ length: SLOTS }, (_, i) => get(`--series-${i + 1}`)),
      tail: Array.from({ length: TAIL }, (_, i) => get(`--tail-${i + 1}`)),
    };
  }

  function rankColor(pal, rank) {
    if (rank < SLOTS) return pal.series[rank];
    if (rank < PIE_ITEMS) return pal.tail[rank - SLOTS];
    return pal.tail[TAIL - 1];
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'X-DiskPie-Token': token, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  // ---------- 深／淺色 ----------

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('diskpie-theme', mode);
    if (view) render();
  }

  // auto 模式下，作業系統切換深／淺色時要跟著重畫（圓餅的填色是取當下的 CSS 變數）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((document.documentElement.getAttribute('data-theme') || 'auto') === 'auto' && view) render();
  });

  el.themeBtn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const now = document.documentElement.getAttribute('data-theme') || 'auto';
    applyTheme(order[(order.indexOf(now) + 1) % order.length]);
  });

  // ---------- 掃描 ----------

  async function loadDrives() {
    const { drives, start } = await api('/api/drives');
    el.driveSelect.innerHTML = '';
    for (const d of drives) {
      const opt = document.createElement('option');
      opt.value = d.path;
      const label = d.label ? `${d.label} (${d.path})` : `${d.kind} (${d.path})`;
      opt.textContent = `${label} — 已用 ${fmtSize(d.used)} / ${fmtSize(d.total)}`;
      el.driveSelect.appendChild(opt);
    }
    const last = localStorage.getItem('diskpie-drive');
    if (last && drives.some((d) => d.path === last)) el.driveSelect.value = last;
    return start;
  }

  function targetPath() {
    return el.pathInput.value.trim() || el.driveSelect.value;
  }

  async function startScan() {
    const path = targetPath();
    if (!path) return;
    localStorage.setItem('diskpie-drive', el.driveSelect.value);
    try {
      await post('/api/scan', { path });
    } catch (err) {
      alert('無法開始掃描：' + err.message);
      return;
    }
    el.scanBtn.disabled = true;
    el.cancelBtn.hidden = false;
    el.status.hidden = false;
    el.statusTitle.textContent = '掃描中…';
    startPolling(() => openPath(path));
  }

  function startPolling(onDone) {
    clearInterval(poller);
    poller = setInterval(async () => {
      let s;
      try { s = await api('/api/status'); } catch { return; }
      el.statusNumbers.textContent =
        `${fmtInt(s.dirs)} 個資料夾 · ${fmtInt(s.files)} 個檔案 · ${fmtSize(s.size)} · ${s.elapsed} 秒`
        + (s.errors ? ` · ${fmtInt(s.errors)} 個無法讀取` : '');
      el.statusCurrent.textContent = s.current || '';
      if (s.state === 'scanning') return;

      clearInterval(poller);
      el.scanBtn.disabled = false;
      el.cancelBtn.hidden = true;
      el.statusCurrent.textContent = '';
      document.querySelector('.spinner').style.visibility = 'hidden';
      if (s.state === 'error') {
        el.statusTitle.textContent = '掃描失敗';
        return;
      }
      el.statusTitle.textContent = s.state === 'cancelled' ? '已停止（結果不完整）' : '掃描完成';
      onDone();
    }, 400);
    document.querySelector('.spinner').style.visibility = 'visible';
  }

  el.scanBtn.addEventListener('click', startScan);
  el.cancelBtn.addEventListener('click', () => post('/api/cancel', {}));
  el.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startScan(); });

  // ---------- 讀取某一層 ----------

  async function openPath(path) {
    let data;
    try {
      data = await api('/api/node?path=' + encodeURIComponent(path));
    } catch (err) {
      alert('無法開啟：' + err.message);
      return;
    }
    view = data;
    showAllRows = false;
    el.empty.hidden = true;
    el.main.hidden = false;
    render();
  }

  // ---------- 組出分段 ----------

  function buildSegments() {
    items = view.children.map((c) => ({
      name: c.name, path: c.path, size: c.size, drillable: c.drillable,
      denied: c.denied, subdirs: c.subdirs, files: c.files, kind: 'dir',
    }));
    if (view.ownSize > 0) {
      items.push({
        name: `（本層檔案 ${fmtInt(view.fileCount)} 個）`, path: view.path,
        size: view.ownSize, drillable: false, kind: 'files',
      });
    }
    items.sort((a, b) => b.size - a.size);

    const total = items.reduce((sum, it) => sum + it.size, 0);
    const pal = readPalette();
    items.forEach((it, i) => {
      it.pct = total ? (it.size / total) * 100 : 0;
      it.color = rankColor(pal, i);
    });

    // 圓餅畫前 PIE_ITEMS 名，其餘合併成一塊「其他」
    const segs = items.slice(0, PIE_ITEMS).map((it) => ({ ...it }));
    const rest = items.slice(PIE_ITEMS);
    if (rest.length) {
      const size = rest.reduce((sum, it) => sum + it.size, 0);
      segs.push({
        name: `其他 ${fmtInt(rest.length)} 個項目`, size, kind: 'other',
        drillable: false, color: pal.tail[TAIL - 1],
        pct: total ? (size / total) * 100 : 0,
      });
    }
    return { segs, total };
  }

  // ---------- 畫圓餅 ----------

  function arcPath(a0, a1) {
    const p = (r, a) => [CX + r * Math.cos(a), CY + r * Math.sin(a)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(R_OUT, a0), [x1, y1] = p(R_OUT, a1);
    const [x2, y2] = p(R_IN, a1), [x3, y3] = p(R_IN, a0);
    return `M${x0} ${y0}A${R_OUT} ${R_OUT} 0 ${large} 1 ${x1} ${y1}`
         + `L${x2} ${y2}A${R_IN} ${R_IN} 0 ${large} 0 ${x3} ${y3}Z`;
  }

  function drawPie(segs, total) {
    const NS = 'http://www.w3.org/2000/svg';
    el.slices.innerHTML = '';
    el.sliceLabels.innerHTML = '';
    segments = segs;

    if (!total) {
      const ring = document.createElementNS(NS, 'path');
      ring.setAttribute('d', arcPath(-Math.PI / 2, Math.PI / 2 - 0.0001)
                            + arcPath(Math.PI / 2, Math.PI * 1.5 - 0.0001));
      ring.setAttribute('fill', 'var(--grid)');
      el.slices.appendChild(ring);
      return;
    }

    let angle = -Math.PI / 2;
    segs.forEach((seg, i) => {
      let sweep = (seg.size / total) * Math.PI * 2;
      if (sweep >= Math.PI * 2 - 1e-6) sweep = Math.PI * 2 - 1e-4;   // 避免整圓退化
      const a0 = angle, a1 = angle + sweep;
      angle = a1;

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', arcPath(a0, a1));
      path.setAttribute('fill', seg.color);
      path.setAttribute('stroke', 'var(--surface-1)');   // 2px 底色間隙，不是描邊框
      path.setAttribute('stroke-width', '2');
      path.setAttribute('class', 'slice');
      path.setAttribute('data-index', String(i));
      path.setAttribute('data-drillable', String(!!seg.drillable));
      path.setAttribute('tabindex', '0');
      path.setAttribute('role', seg.drillable ? 'button' : 'img');
      path.setAttribute('aria-label',
        `${seg.name}，${fmtSize(seg.size)}，佔 ${fmtPct(seg.pct)}` + (seg.drillable ? '，按下可展開' : ''));
      el.slices.appendChild(path);

      // 直接標示：圓環外側，用文字色而非該分段的顏色
      const frac = seg.size / total;
      if (frac >= LABEL_MIN) {
        const mid = (a0 + a1) / 2;
        const lx = CX + R_LABEL * Math.cos(mid), ly = CY + R_LABEL * Math.sin(mid);
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', lx.toFixed(1));
        text.setAttribute('y', ly.toFixed(1));
        text.setAttribute('fill', 'var(--text-secondary)');
        if (frac >= NAME_MIN) {
          const l1 = document.createElementNS(NS, 'tspan');
          l1.setAttribute('x', lx.toFixed(1)); l1.setAttribute('dy', '-0.5em');
          l1.setAttribute('fill', 'var(--text-primary)');
          l1.textContent = ellipsis(seg.name, 12);
          const l2 = document.createElementNS(NS, 'tspan');
          l2.setAttribute('x', lx.toFixed(1)); l2.setAttribute('dy', '1.15em');
          l2.textContent = fmtPct(seg.pct);
          text.append(l1, l2);
        } else {
          text.textContent = fmtPct(seg.pct);
        }
        el.sliceLabels.appendChild(text);
      }
    });
  }

  // ---------- 表格 ----------

  function drawTable() {
    el.tbody.innerHTML = '';
    const rows = showAllRows ? items : items.slice(0, MAX_ROWS);

    for (const [i, it] of rows.entries()) {
      const tr = document.createElement('tr');
      tr.className = 'row';
      tr.dataset.index = String(i);
      tr.dataset.drillable = String(!!it.drillable);
      if (it.drillable) { tr.tabIndex = 0; tr.setAttribute('role', 'button'); }

      const name = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'name-cell';
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = it.color;
      const label = document.createElement('span');
      label.className = 'name-text';
      label.textContent = it.name;
      label.title = it.name;
      wrap.append(chip, label);
      if (it.denied) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '無權限';
        wrap.appendChild(tag);
      }
      name.appendChild(wrap);

      const size = document.createElement('td');
      size.className = 'num';
      size.textContent = fmtSize(it.size);

      const pct = document.createElement('td');
      pct.className = 'num';
      pct.textContent = fmtPct(it.pct);

      const barCell = document.createElement('td');
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(it.pct, it.size > 0 ? 1 : 0) + '%';
      fill.style.background = it.color;
      bar.appendChild(fill);
      barCell.appendChild(bar);

      tr.append(name, size, pct, barCell);
      el.tbody.appendChild(tr);
    }

    if (!items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = view.denied ? '沒有讀取這個資料夾的權限。' : '這個資料夾是空的。';
      tr.appendChild(td);
      el.tbody.appendChild(tr);
    } else if (!showAllRows && items.length > MAX_ROWS) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = `顯示其餘 ${fmtInt(items.length - MAX_ROWS)} 個項目`;
      btn.addEventListener('click', () => { showAllRows = true; render(); });
      td.appendChild(btn);
      tr.appendChild(td);
      el.tbody.appendChild(tr);
    }
  }

  // ---------- 麵包屑 ----------

  function drawBreadcrumb() {
    el.breadcrumb.innerHTML = '';
    view.breadcrumb.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        el.breadcrumb.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = 'crumb' + (i === view.breadcrumb.length - 1 ? ' current' : '');
      btn.textContent = c.name;
      btn.title = c.path;
      if (i < view.breadcrumb.length - 1) btn.addEventListener('click', () => openPath(c.path));
      el.breadcrumb.appendChild(btn);
    });
  }

  // ---------- 整層重繪 ----------

  function render() {
    const { segs, total } = buildSegments();

    el.chartTitle.textContent = view.path;
    el.chartTitle.title = view.path;
    drawBreadcrumb();
    drawPie(segs, total);
    drawTable();
    setCenter();

    el.upBtn.disabled = !view.parent;
    el.rootBtn.disabled = view.path === view.root;

    el.filesBlock.hidden = !view.files.length;
    el.filesCount.textContent = view.files.length ? `（共 ${fmtInt(view.fileCount)} 個，${fmtSize(view.ownSize)}）` : '';
    el.filesTbody.innerHTML = '';
    for (const f of view.files) {
      const tr = document.createElement('tr');
      const n = document.createElement('td');
      n.textContent = f.name;
      const s = document.createElement('td');
      s.textContent = fmtSize(f.size);
      tr.append(n, s);
      el.filesTbody.appendChild(tr);
    }
  }

  function setCenter(seg) {
    if (seg) {
      el.centerLabel.textContent = ellipsis(seg.name, 22);
      el.centerLabel.title = seg.name;
      el.centerValue.textContent = fmtSize(seg.size);
      el.centerSub.textContent = `佔本層 ${fmtPct(seg.pct)}`;
    } else {
      const atRoot = view.path === view.root;
      const rootBase = view.root.replace(/\\+$/, '').split('\\').pop() || view.root;
      const label = atRoot
        ? (/^[A-Za-z]:\\?$/.test(view.root) ? '整顆磁碟已用' : rootBase)
        : view.name;
      el.centerLabel.textContent = ellipsis(label, 22);
      el.centerLabel.title = view.path;
      el.centerValue.textContent = fmtSize(view.size);
      el.centerSub.textContent = `${fmtInt(view.children.length)} 個子資料夾`;
    }
  }

  // ---------- 互動 ----------

  function highlight(index) {
    el.slices.classList.toggle('dimmed', index !== null);
    for (const p of el.slices.children) {
      p.classList.toggle('active', String(index) === p.dataset.index);
    }
    for (const tr of el.tbody.children) {
      if (tr.dataset.index !== undefined) {
        tr.classList.toggle('active', index !== null && String(index) === tr.dataset.index);
      }
    }
  }

  function showTooltip(seg, evt) {
    el.tooltip.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'tt-name';
    name.textContent = seg.name;
    const size = document.createElement('div');
    size.className = 'tt-row';
    size.textContent = `${fmtSize(seg.size)} · 佔 ${fmtPct(seg.pct)}`;
    el.tooltip.append(name, size);
    if (seg.kind === 'dir') {
      const sub = document.createElement('div');
      sub.className = 'tt-row';
      sub.textContent = `${fmtInt(seg.subdirs)} 個子資料夾 · ${fmtInt(seg.files)} 個檔案`;
      el.tooltip.appendChild(sub);
    }
    el.tooltip.hidden = false;
    const box = el.chartWrap.getBoundingClientRect();
    const x = evt.clientX - box.left + 14;
    const y = evt.clientY - box.top + 14;
    const w = el.tooltip.offsetWidth, h = el.tooltip.offsetHeight;
    el.tooltip.style.left = Math.min(x, box.width - w - 4) + 'px';
    el.tooltip.style.top = Math.min(y, box.height - h - 4) + 'px';
  }

  function hideTooltip() {
    el.tooltip.hidden = true;
  }

  function segFromEvent(evt) {
    const path = evt.target.closest('.slice');
    return path ? { seg: segments[+path.dataset.index], index: +path.dataset.index } : null;
  }

  el.slices.addEventListener('mousemove', (evt) => {
    const hit = segFromEvent(evt);
    if (!hit) return;
    highlight(hit.index);
    setCenter(hit.seg);
    showTooltip(hit.seg, evt);
  });

  el.slices.addEventListener('mouseleave', () => {
    highlight(null); setCenter(); hideTooltip();
  });

  el.slices.addEventListener('click', (evt) => {
    const hit = segFromEvent(evt);
    if (hit && hit.seg.drillable) { hideTooltip(); openPath(hit.seg.path); }
  });

  el.slices.addEventListener('focusin', (evt) => {
    const path = evt.target.closest('.slice');
    if (!path) return;
    const i = +path.dataset.index;
    highlight(i); setCenter(segments[i]);
  });
  el.slices.addEventListener('focusout', () => { highlight(null); setCenter(); });
  el.slices.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const path = evt.target.closest('.slice');
    if (!path) return;
    const seg = segments[+path.dataset.index];
    if (seg && seg.drillable) { evt.preventDefault(); openPath(seg.path); }
  });

  el.tbody.addEventListener('mouseover', (evt) => {
    const tr = evt.target.closest('tr.row');
    if (!tr) return;
    const i = +tr.dataset.index;
    highlight(i < PIE_ITEMS ? i : segments.length - 1);   // 落在「其他」裡的列對應那一塊
  });
  el.tbody.addEventListener('mouseleave', () => highlight(null));

  function drillFromRow(tr) {
    const it = items[+tr.dataset.index];
    if (it && it.drillable) openPath(it.path);
  }
  el.tbody.addEventListener('click', (evt) => {
    const tr = evt.target.closest('tr.row');
    if (tr) drillFromRow(tr);
  });
  el.tbody.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const tr = evt.target.closest('tr.row');
    if (tr) { evt.preventDefault(); drillFromRow(tr); }
  });

  el.upBtn.addEventListener('click', () => view && view.parent && openPath(view.parent));
  el.rootBtn.addEventListener('click', () => view && openPath(view.root));
  document.getElementById('center').parentElement.addEventListener('click', (evt) => {
    // 點圓心（甜甜圈中間的空白）回上一層
    if (evt.target.closest('.slice')) return;
    if (view && view.parent) openPath(view.parent);
  });

  el.openBtn.addEventListener('click', async () => {
    try { await post('/api/open', { path: view.path }); }
    catch (err) { alert('無法開啟：' + err.message); }
  });

  el.rescanBtn.addEventListener('click', async () => {
    const path = view.path;
    el.status.hidden = false;
    el.statusTitle.textContent = '重新掃描中…';
    el.rescanBtn.disabled = true;
    startPolling(() => { el.rescanBtn.disabled = false; openPath(path); });
    try { await post('/api/rescan', { path }); }
    catch (err) { el.rescanBtn.disabled = false; alert('重新掃描失敗：' + err.message); }
  });

  document.addEventListener('keydown', (evt) => {
    if (evt.target.matches('input, select, textarea')) return;
    if (!view) return;
    if (evt.key === 'Backspace' || (evt.altKey && evt.key === 'ArrowLeft')) {
      evt.preventDefault();
      if (view.parent) openPath(view.parent);
    }
  });

  window.addEventListener('resize', () => { if (view) hideTooltip(); });

  // ---------- 啟動 ----------

  (async function init() {
    applyTheme(localStorage.getItem('diskpie-theme') || 'auto');
    const res = await fetch('/token');
    token = (await res.json()).token;

    const start = await loadDrives();

    // 重新整理頁面時，伺服器裡若已有掃描結果就直接顯示，不用重掃
    const status = await api('/api/status');
    if (status.ready) {
      el.pathInput.value = status.root;
      await openPath(status.root);
      return;
    }
    if (start) { el.pathInput.value = start; startScan(); }
  })().catch((err) => {
    el.empty.textContent = '啟動失敗：' + err.message;
  });
})();
