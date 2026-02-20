/* CCFOLIA .gachaRS core v0.1.2
 * Fixes:
 *  ① owner名が「名前.gachaRS」になる問題を修正（末尾のコマンド混入を除去）
 *  ② /add v2系と同系統の「時刻参照」誤爆防止に刷新（timeが取れない間は処理しない／時刻+発言者で安定キー化）
 *  ③ 座標は“中心指定”でハードコードし、実配置は左上基準に合わせて (x,y) に -12*駒サイズ を自動オフセット
 *  ④ VERSION を 0.1.2 に修正
 */
(function () {
  'use strict';

  // =========================
  // Meta
  // =========================
  const VERSION = '0.1.2';
  const LOG_PREFIX = '[CCF .gachaRS]';

  // 二重ロード防止
  if (window.__CCF_GACHARS_CORE_V0_LOADED__) {
    console.log(`${LOG_PREFIX} v${VERSION}（core）は既にロード済みです↩️`);
    return;
  }
  window.__CCF_GACHARS_CORE_V0_LOADED__ = true;

  console.log(`${LOG_PREFIX} v${VERSION}（core）をロードしました📦`);

  // =========================
  // Config
  // =========================
  const COMMAND = '.gachaRS';
  const DRAW_COUNT = 5;

  // レア確率（合計100）
  const PROB_STAR1 = 75;
  const PROB_STAR2 = 20;
  const PROB_STAR3 = 5;

  // 待機（各貼り付け動作やmove動作の前）
  const STEP_WAIT_MS = 500;

  // DB（単一）
  const DB_URL = 'https://raw.githubusercontent.com/4bxy/SWmonsterDB/refs/heads/main/gachaRS.json';

  // localStorage cache key
  const DB_CACHE_KEY = '__CCF_GACHARS_DB_JSON__';
  const DB_CACHE_META_KEY = '__CCF_GACHARS_DB_META__'; // { savedAt:number, version:any, count:any }

  // =========================
  // /add方式：時刻参照の誤爆防止（重要）
  // =========================
  // 「同じ投稿（同じ時刻の同じ発言者）」を、UI再描画やリロードで二度拾わないための仕組み。
  // - time が取得できない段階では処理しない（ここが不安定だと誤爆の温床）
  // - key は timeText + speaker の組で安定化（owner取得が安定した前提）
  // - TTLで掃除して肥大化を防ぐ
  const PROCESSED_KEY = '__CCF_GACHARS_PROCESSED_V0__'; // JSON: { [key:string]: number(lastSeenMs) }
  const PROCESSED_TTL_MS = 30 * 60 * 1000; // 30分
  const PROCESSED_MAX_KEYS = 300;

  // =========================
  // Layout
  // =========================
  // ここは “中心座標” をハードコードする（ユーザーが狙いたい中心位置）
  const LAYOUT_CENTER_XY = [
    { x: -240, y: -240 },
    { x: -120, y: -240 },
    { x: 0, y: -240 },
    { x: 120, y: -240 },
    { x: 240, y: -240 },
  ];

  // 召喚駒の固定サイズ（要求：7）
  const TOKEN_SIZE = { width: 7, height: 7 };

  // ココフォリアの駒座標は「左上」基準なので、中心指定から左上へ補正する
  // 仕様：x,yともに -12*駒サイズ
  const TOPLEFT_OFFSET = {
    x: -12 * TOKEN_SIZE.width,
    y: -12 * TOKEN_SIZE.height,
  };

  // =========================
  // Utilities
  // =========================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clampInt(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, Math.trunc(v)));
  }

  function normalizeText(s) {
    return (s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function normalizeName(s) {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  function pickRandom(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const i = Math.floor(Math.random() * arr.length);
    return arr[i] ?? null;
  }

  function pickRarity() {
    const r = Math.floor(Math.random() * 100) + 1;
    if (r <= PROB_STAR1) return 1;
    if (r <= PROB_STAR1 + PROB_STAR2) return 2;
    return 3;
  }

  function safeJsonParse(s, fallback) {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }

  function readProcessedMap() {
    const raw = localStorage.getItem(PROCESSED_KEY);
    const obj = raw ? safeJsonParse(raw, {}) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  }

  function writeProcessedMap(map) {
    try {
      localStorage.setItem(PROCESSED_KEY, JSON.stringify(map));
    } catch (e) {
      console.warn(LOG_PREFIX, 'processedMap の保存に失敗:', e);
    }
  }

  function pruneProcessedMap(map) {
    const now = Date.now();
    const entries = Object.entries(map || {});
    const kept = entries.filter(([, ts]) => (now - Number(ts)) <= PROCESSED_TTL_MS);
    kept.sort((a, b) => Number(b[1]) - Number(a[1]));
    const sliced = kept.slice(0, PROCESSED_MAX_KEYS);
    const out = {};
    for (const [k, v] of sliced) out[k] = v;
    return out;
  }

  function markProcessed(key) {
    const now = Date.now();
    let map = readProcessedMap();
    map[key] = now;
    map = pruneProcessedMap(map);
    writeProcessedMap(map);
  }

  function isAlreadyProcessed(key) {
    const now = Date.now();
    let map = readProcessedMap();
    map = pruneProcessedMap(map);
    writeProcessedMap(map);
    const ts = Number(map[key]);
    return Number.isFinite(ts) && (now - ts) <= PROCESSED_TTL_MS;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // =========================
  // DB Load & Index
  // =========================
  let dbItems = [];
  let rarityBuckets = { 1: [], 2: [], 3: [] };
  let dbReady = false;
  let dbLoadingPromise = null;

  async function fetchDbNoStore() {
    console.log(`${LOG_PREFIX} DB取得:`, DB_URL);
    const res = await fetch(DB_URL, { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`DB fetch failed: HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  }

  function validateAndExtractItems(json) {
    if (!json || typeof json !== 'object') return [];
    const items = json.items;
    if (!Array.isArray(items)) return [];
    return items;
  }

  function indexByRarity(items) {
    const b1 = [];
    const b2 = [];
    const b3 = [];
    for (const it of items) {
      const r = Number(it?.rarity);
      if (r === 1) b1.push(it);
      else if (r === 2) b2.push(it);
      else if (r === 3) b3.push(it);
    }
    rarityBuckets = { 1: b1, 2: b2, 3: b3 };
  }

  async function initDb() {
    if (dbReady) return true;
    if (dbLoadingPromise) return dbLoadingPromise;

    dbLoadingPromise = (async () => {
      const cached = localStorage.getItem(DB_CACHE_KEY);
      if (cached) {
        const json = safeJsonParse(cached, null);
        const items = validateAndExtractItems(json);
        if (items.length > 0) {
          dbItems = items;
          indexByRarity(dbItems);
          dbReady = true;
          console.log(`${LOG_PREFIX} DB: localStorage から読み込み (${dbItems.length}件)`);
          return true;
        }
      }

      try {
        const json = await fetchDbNoStore();
        const items = validateAndExtractItems(json);
        if (items.length === 0) {
          console.warn(`${LOG_PREFIX} DBが空、または形式不正です。items[] が見つかりません。`);
          return false;
        }
        dbItems = items;
        indexByRarity(dbItems);
        dbReady = true;

        try {
          localStorage.setItem(DB_CACHE_KEY, JSON.stringify(json));
          localStorage.setItem(DB_CACHE_META_KEY, JSON.stringify({
            savedAt: Date.now(),
            version: json?.version ?? null,
            count: json?.count ?? items.length,
          }));
        } catch (e) {
          console.warn(`${LOG_PREFIX} DBキャッシュ保存に失敗:`, e);
        }

        console.log(`${LOG_PREFIX} DB: GitHub から取得 (${dbItems.length}件)`);
        return true;
      } catch (e) {
        console.error(`${LOG_PREFIX} DB取得に失敗:`, e);
        return false;
      }
    })();

    return dbLoadingPromise;
  }

  // =========================
  // Memo builder
  // =========================
  function hyphenIfEmpty(v) {
    const s = (v ?? '').toString().trim();
    return s ? s : '-';
  }

  function buildMemoFromItem(item, ownerName) {
    const id = item?.id;
    const cost = hyphenIfEmpty(item?.cost);
    const trigger = hyphenIfEmpty(item?.trigger);
    const check = hyphenIfEmpty(item?.check);

    const effectRaw = (item?.effect ?? '').toString();
    const effect = effectRaw.trim() ? normalizeText(effectRaw).trim() : '-';

    const specialRaw = (item?.special ?? '').toString();
    const special = normalizeText(specialRaw).trim();

    const flavorRaw = (item?.flavor ?? '').toString();
    const flavor = flavorRaw.trim() ? normalizeText(flavorRaw).trim() : '-';

    const lines = [];
    lines.push(`🔷ItemID：${id}`);
    lines.push(`🔷所有者：${ownerName}`);
    lines.push(`_______________________________________________________`);
    lines.push(`【コスト】${cost}`);
    lines.push(`【発動】${trigger}`);
    lines.push(`【判定】${check}`);
    lines.push(`_______________________________________________________`);
    lines.push(`【効果】`);
    lines.push(`${effect}`);
    if (special) {
      lines.push('');
      lines.push('★特殊処理');
      lines.push(`${special}`);
    }
    lines.push(`_______________________________________________________`);
    lines.push(`${flavor}`);

    return lines.join('\n');
  }

  // =========================
  // Clipboard + Paste ('.call' 相当)
  // =========================
  let lastSuccessPoint = null;

  function closeAnyMenuByEsc() {
    const active = document.activeElement || document.body;
    active.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
    }));
    active.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
    }));
  }

  async function tryContextMenuAtPoint(x, y, maxWaitMs = 700) {
    const target = document.elementFromPoint(x, y);
    if (!target) return false;

    ['mousedown', 'mouseup', 'contextmenu'].forEach(type => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 2, buttons: 2, which: 3, clientX: x, clientY: y,
      }));
    });

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const menus = document.querySelectorAll('ul[role="menu"], ul.MuiMenu-list');
      for (const menu of menus) {
        const items = menu.querySelectorAll('li.MuiMenuItem-root, li[role="menuitem"]');
        for (const li of items) {
          const text = (li.textContent || '').trim();
          if (text && (text.includes('貼り付け') || /paste/i.test(text))) {
            li.click();
            return true;
          }
        }
      }
      await sleep(50);
    }
    return false;
  }

  function getCandidatePoints() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const pts = [];
    if (lastSuccessPoint) pts.push(lastSuccessPoint);

    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const offsets = [
      [0, 0], [80, 0], [-80, 0], [0, 80], [0, -80],
      [140, 60], [-140, 60], [140, -60], [-140, -60],
    ];
    for (const [ox, oy] of offsets) pts.push({ x: cx + ox, y: cy + oy });

    pts.push({ x: clampInt(w * 0.55, 10, w - 10), y: clampInt(h * 0.55, 10, h - 10) });
    pts.push({ x: clampInt(w * 0.45, 10, w - 10), y: clampInt(h * 0.45, 10, h - 10) });
    return pts;
  }

  async function setClipboardText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
      return true;
    }
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  async function pasteByContextMenu() {
    closeAnyMenuByEsc();
    await sleep(50);

    const pts = getCandidatePoints();
    for (const p of pts) {
      closeAnyMenuByEsc();
      await sleep(40);

      const ok = await tryContextMenuAtPoint(p.x, p.y, 800);
      if (ok) {
        lastSuccessPoint = { x: p.x, y: p.y };
        return true;
      }
    }
    return false;
  }

  // =========================
  // Move ('.move' 相当)
  // =========================
  function simulateInput(el, value) {
    const setter =
      (el && el.constructor && Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set) ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
  }

  function findMovablesByName(name) {
    const target = normalizeName(name);
    const movables = Array.from(document.querySelectorAll('div.movable')).filter(isVisible);

    const matches = [];
    for (const mv of movables) {
      const sp = mv.querySelector('span');
      const t = normalizeName(sp?.textContent || '');
      if (t === target) matches.push(mv);
    }
    return matches;
  }

  async function rightClickAndClickMenuItemAtPoint(x, y, includeText, maxWaitMs = 700) {
    const targetEl = document.elementFromPoint(x, y);
    if (!targetEl) return false;

    ['mousedown', 'mouseup', 'contextmenu'].forEach(type => {
      targetEl.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 2, buttons: 2, which: 3, clientX: x, clientY: y,
      }));
    });

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const menus = document.querySelectorAll('ul[role="menu"], ul.MuiMenu-list');
      for (const menu of menus) {
        const items = menu.querySelectorAll('li.MuiMenuItem-root, li[role="menuitem"]');
        for (const li of items) {
          const text = (li.textContent || '').trim();
          if (text && text.includes(includeText)) {
            li.click();
            return true;
          }
        }
      }
      await sleep(50);
    }
    return false;
  }

  function findCharacterEditDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const d of dialogs) {
      if (d.querySelector('svg[data-testid="CloseIcon"]')) return d;
    }
    return dialogs[0] || null;
  }

  async function waitForDialog(maxWaitMs = 1500) {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const d = findCharacterEditDialog();
      if (d) return d;
      await sleep(50);
    }
    return null;
  }

  function closeDialog(dialog) {
    const closeBtn = dialog?.querySelector('button svg[data-testid="CloseIcon"]')?.closest('button');
    if (closeBtn) {
      closeBtn.click();
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  function findNameInput(dialog) {
    if (!dialog) return null;

    const direct = dialog.querySelector('input[name="name"], input[name="characterName"], input[aria-label="名前"]');
    if (direct) return direct;

    const labelEl = Array.from(dialog.querySelectorAll('*'))
      .find(el => (el.textContent || '').trim() === '名前');
    if (labelEl) {
      const block = labelEl.closest('div,section,header') || labelEl.parentElement;
      const cand = block?.querySelector?.('input[type="text"], input:not([type]), textarea');
      if (cand) return cand;
    }

    const inputs = Array.from(dialog.querySelectorAll('input'));
    const filtered = inputs.filter(i => {
      const nm = (i.getAttribute('name') || '').toLowerCase();
      if (nm === 'x' || nm === 'y') return false;
      if (nm.includes('initiative')) return false;
      if (nm.includes('init')) return false;
      return (i.type === 'text' || !i.type);
    });
    return filtered[0] || null;
  }

  function getDialogName(dialog) {
    const inp = findNameInput(dialog);
    return normalizeName(inp?.value || '');
  }

  async function setXYInDialog(dialog, x, y) {
    const ix = dialog.querySelector('input[name="x"]');
    const iy = dialog.querySelector('input[name="y"]');
    if (!ix || !iy) return false;

    simulateInput(ix, String(x));
    await sleep(20);
    simulateInput(iy, String(y));
    await sleep(20);

    iy.dispatchEvent(new Event('blur', { bubbles: true }));
    ix.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(50);

    closeDialog(dialog);
    return true;
  }

  async function moveOneTokenByNameToXY(name, x, y, knownBeforeSet) {
    const after = findMovablesByName(name);
    let target = null;

    if (knownBeforeSet && knownBeforeSet.size > 0) {
      for (let i = after.length - 1; i >= 0; i--) {
        const mv = after[i];
        if (!knownBeforeSet.has(mv)) {
          target = mv;
          break;
        }
      }
    }
    if (!target) target = after[after.length - 1] || null;

    if (!target) {
      console.warn(`${LOG_PREFIX} move: 駒が見つかりません:`, name);
      return false;
    }

    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    const okMenu = await rightClickAndClickMenuItemAtPoint(cx, cy, '編集', 800);
    if (!okMenu) {
      console.warn(`${LOG_PREFIX} move: 右クリックメニュー「編集」を押せませんでした:`, name);
      return false;
    }

    const dialog = await waitForDialog(2000);
    if (!dialog) {
      console.warn(`${LOG_PREFIX} move: 編集ダイアログが開きませんでした`);
      return false;
    }

    const openedName = getDialogName(dialog);
    const expectedName = normalizeName(name);
    if (!openedName) {
      console.warn(`${LOG_PREFIX} move: ダイアログから名前取得不能。安全のためキャンセル`, { expectedName });
      closeDialog(dialog);
      return false;
    }
    if (openedName !== expectedName) {
      console.warn(`${LOG_PREFIX} move: 別の駒を開いた疑い。キャンセル`, { expectedName, openedName });
      closeDialog(dialog);
      return false;
    }

    const okXY = await setXYInDialog(dialog, x, y);
    if (!okXY) {
      console.warn(`${LOG_PREFIX} move: x/y input が見つかりませんでした`);
      closeDialog(dialog);
      return false;
    }

    return true;
  }

  // =========================
  // Build ccfolia paste JSON
  // =========================
  function buildPasteJson(item, ownerName, rarity) {
    const base = item?.ccfoliaPaste && typeof item.ccfoliaPaste === 'object'
      ? JSON.parse(JSON.stringify(item.ccfoliaPaste))
      : { kind: 'character', data: {} };

    if (!base.data || typeof base.data !== 'object') base.data = {};
    base.kind = base.kind || 'character';

    const rawName = (item?.name ?? base.data.name ?? 'アイテム').toString();
    const nameWithRarity = `【★${rarity}】${rawName}`;

    base.data.name = nameWithRarity;
    base.data.memo = buildMemoFromItem(item, ownerName);

    const icon = (item?.imageUrl ?? '').toString().trim();
    if (icon) base.data.iconUrl = icon;
    else if ('iconUrl' in base.data) delete base.data.iconUrl;

    // 駒サイズ固定
    base.data.width = TOKEN_SIZE.width;
    base.data.height = TOKEN_SIZE.height;

    // ステータス非表示 + そもそも空にする
    base.data.hideStatus = true;
    base.data.status = [];
    base.data.params = [];

    // 余計な表示を増やさない
    base.data.commands = '';
    base.data.initiative = base.data.initiative ?? 0;
    base.data.externalUrl = base.data.externalUrl ?? '';

    return base;
  }

  // =========================
  // Chat parsing & trigger
  // =========================
  const processedNodes = new WeakSet();

  function getMsgBodyP(node) {
    if (!(node instanceof HTMLElement)) return null;
    if (node.matches && node.matches('p.MuiListItemText-secondary')) return node;
    return node.querySelector?.('p.MuiListItemText-secondary') || null;
  }

  function getMsgContainerFromBodyP(p) {
    return p?.closest('div.MuiListItem-root') || p?.closest('li.MuiListItem-root') || null;
  }

  function extractTimeText(container) {
    if (!container) return '';
    const timeEl = container.querySelector('time');
    const text = timeEl?.textContent?.trim() || '';
    if (text) return text;

    const t =
      container.querySelector('span[class*="time"]')?.textContent?.trim() ||
      container.querySelector('p[class*="time"]')?.textContent?.trim() ||
      '';
    return (t || '').trim();
  }

  function extractMessageTextFromNode(node) {
    const p = getMsgBodyP(node);
    const text = (p?.textContent ?? node?.innerText ?? '').trim();
    return normalizeText(text).trim();
  }

  // ★ 修正①：所有者名にコマンド本文が混入するケースを除去
  function sanitizeSpeakerName(name) {
    let n = normalizeName(name);

    // 「4bxy - 今日 2:34」形式の左側だけ
    if (n.includes(' - ')) n = normalizeName(n.split(' - ')[0]);

    // 末尾/混入の ".gachaRS" を除去（スペース無し連結も含む）
    // 例: "4bxy.gachaRS" / "4bxy .gachaRS"
    const cmd = COMMAND; // ".gachaRS"
    const reTail1 = new RegExp(`${escapeRegExp(cmd)}$`, 'i');
    const reTail2 = new RegExp(`${escapeRegExp(cmd).replace(/^\\./, '\\.?')}$`, 'i'); // 念のため "."なしも許容
    n = n.replace(reTail1, '');
    n = n.replace(reTail2, '');
    n = n.replace(/\.$/, ''); // "4bxy." みたいにドットだけ残った場合

    return normalizeName(n);
  }

  function extractSpeakerName(container, messageText) {
    if (!container) return '';

    // できるだけ「発言者名っぽい要素」を優先で拾う
    const raw =
      container.querySelector('p.MuiListItemText-primary')?.textContent ||
      container.querySelector('span.MuiListItemText-primary')?.textContent ||
      container.querySelector('h6.MuiTypography-root')?.textContent || // /add v0.4 系の拾い方
      container.querySelector('p[class*="primary"]')?.textContent ||
      container.querySelector('span[class*="primary"]')?.textContent ||
      '';

    let name = sanitizeSpeakerName(raw);

    // フォールバック：本文と同一／コマンドそのもの等は除外して候補を探す
    if (!name || name === messageText || name === COMMAND) {
      const elems = Array.from(container.querySelectorAll('p,span,h6,div'));
      const candidates = [];

      for (const el of elems) {
        const t0 = normalizeName(el.textContent || '');
        if (!t0) continue;

        // 本文やコマンド本文は除外
        if (t0 === messageText) continue;
        if (t0 === COMMAND) continue;

        // 時刻っぽいもの除外
        if (/^\d{1,2}:\d{2}$/.test(t0)) continue;
        if (/(今日|昨日|明日)\s*\d{1,2}:\d{2}/.test(t0)) continue;

        const t = sanitizeSpeakerName(t0);

        // まだコマンドが残ってる/空/長すぎるものは除外
        if (!t) continue;
        if (t === COMMAND) continue;
        if (t.length > 40) continue;

        candidates.push(t);
      }

      if (candidates.length > 0) name = candidates[0];
    }

    return sanitizeSpeakerName(name);
  }

  // ★ 修正②：/add式（時刻参照）で安定キー化
  // - timeText が取れない間は処理しない（誤爆の主因になるため）
  function makeProcessedKey(container, messageText) {
    const timeText = extractTimeText(container) || '';
    if (!timeText) return ''; // timeが取れないなら「まだ処理しない」

    const speaker = extractSpeakerName(container, messageText) || '';
    if (!speaker) return ''; // speakerが取れないなら「まだ処理しない」

    // /addと同様に「時刻+発言者」ベース（本文は固定なので入れても意味が薄い）
    return `${timeText}__${speaker}`;
  }

  // =========================
  // Main gacha runner
  // =========================
  let isRunning = false;

  async function runGacha5(ownerName) {
    const okDb = await initDb();
    if (!okDb) {
      console.warn(`${LOG_PREFIX} DBが利用できないため中断します。`);
      return;
    }

    if (!rarityBuckets[1]?.length || !rarityBuckets[2]?.length || !rarityBuckets[3]?.length) {
      console.warn(`${LOG_PREFIX} DB内の rarity 1/2/3 のいずれかが空です:`, {
        r1: rarityBuckets[1]?.length ?? 0,
        r2: rarityBuckets[2]?.length ?? 0,
        r3: rarityBuckets[3]?.length ?? 0,
      });
      return;
    }

    const results = [];
    for (let i = 0; i < DRAW_COUNT; i++) {
      const rarity = pickRarity();
      const pool = rarityBuckets[rarity] || [];
      const item = pickRandom(pool);
      if (!item) {
        console.warn(`${LOG_PREFIX} 抽選に失敗（pool空）: rarity=${rarity}`);
        continue;
      }
      results.push({ rarity, item });
    }

    console.log(`${LOG_PREFIX} 抽選結果:`, results.map(r => `★${r.rarity}:${r.item?.name}`).join(' / '));

    for (let i = 0; i < results.length; i++) {
      const { rarity, item } = results[i];

      const rawName = (item?.name ?? `Item-${item?.id ?? i + 1}`).toString();
      const tokenName = `【★${rarity}】${rawName}`;

      // 貼り付け前 wait
      await sleep(STEP_WAIT_MS);

      // 重複名対策：貼り付け後に “増えた個体” を優先して掴む
      const beforeSet = new Set(findMovablesByName(tokenName));

      const pasteObj = buildPasteJson(item, ownerName, rarity);
      const text = JSON.stringify(pasteObj);

      const okClip = await setClipboardText(text);
      if (!okClip) {
        console.warn(`${LOG_PREFIX} クリップボード書き込みに失敗（権限/設定確認）`);
        return;
      }

      const okPaste = await pasteByContextMenu();
      if (!okPaste) {
        console.warn(`${LOG_PREFIX} 「貼り付け」自動クリックに失敗（右クリック座標/メニュー検出）`);
        return;
      }

      console.log(`${LOG_PREFIX} 貼り付け完了: ★${rarity} ${tokenName}`);

      // move前 wait
      await sleep(STEP_WAIT_MS);

      // ★ 修正③：中心座標 → 左上座標へ補正
      const center = LAYOUT_CENTER_XY[i] || LAYOUT_CENTER_XY[LAYOUT_CENTER_XY.length - 1] || { x: 0, y: 0 };
      const pos = {
        x: center.x + TOPLEFT_OFFSET.x,
        y: center.y + TOPLEFT_OFFSET.y,
      };

      const okMove = await moveOneTokenByNameToXY(tokenName, pos.x, pos.y, beforeSet);
      console.log(`${LOG_PREFIX} move ${okMove ? 'OK' : 'NG'}:`, tokenName, 'center=>', center, 'topleft=>', pos);
    }

    console.log(`${LOG_PREFIX} 5連処理完了✅`);
  }

  // =========================
  // Observer
  // =========================
  function handleNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (processedNodes.has(node)) return;

    const msgText = extractMessageTextFromNode(node);
    if (!msgText) return;

    // コマンドは完全一致のみ
    if (msgText.trim() !== COMMAND) return;

    const p = getMsgBodyP(node);
    const container = getMsgContainerFromBodyP(p) || node.closest?.('div.MuiListItem-root, li.MuiListItem-root') || null;

    // ★ 修正②：timeText/speakerが取れないなら処理しない（誤爆防止の最重要ポイント）
    const key = makeProcessedKey(container, msgText);
    if (!key) {
      // まだDOMが揃ってない可能性がある。ここでは何もしない（後で再スキャン/再追加で拾う）
      return;
    }

    if (isAlreadyProcessed(key)) {
      processedNodes.add(node);
      // console.debug(`${LOG_PREFIX} 再発火防止で無視:`, key);
      return;
    }

    processedNodes.add(node);
    markProcessed(key);

    const speaker = extractSpeakerName(container, msgText) || '不明';
    console.log(`${LOG_PREFIX} 検知:`, { command: msgText, speaker, key });

    if (isRunning) {
      console.warn(`${LOG_PREFIX} 既に実行中のため、この .gachaRS は無視します（衝突防止）`);
      return;
    }

    (async () => {
      isRunning = true;
      try {
        await runGacha5(speaker);
      } catch (e) {
        console.error(`${LOG_PREFIX} 実行エラー:`, e);
      } finally {
        isRunning = false;
      }
    })();
  }

  function scanExistingOnce() {
    const ps = Array.from(document.querySelectorAll('p.MuiListItemText-secondary'));
    for (const p of ps) handleNode(p);
  }

  const observer = new MutationObserver((mutList) => {
    for (const m of mutList) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;

        if (n.matches?.('p.MuiListItemText-secondary')) {
          handleNode(n);
          continue;
        }

        const ps = n.querySelectorAll?.('p.MuiListItemText-secondary') || [];
        ps.forEach((p) => handleNode(p));
      }
    }
  });

  function startObserver() {
    const root =
      document.querySelector('div.MuiList-root') ||
      document.querySelector('ul.MuiList-root') ||
      document.querySelector('[class*="Chat"]') ||
      document.body;

    observer.observe(root, { childList: true, subtree: true });
    console.log(`${LOG_PREFIX} chat監視開始:`, root);
  }

  // 起動
  scanExistingOnce();
  startObserver();

  initDb().then((ok) => {
    if (ok) console.log(`${LOG_PREFIX} DB先読み完了✅`);
  });

})();
