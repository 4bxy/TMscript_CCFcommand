/* CCFOLIA .gachaRS core v2.0.1 */
(function () {
  'use strict';

  // =========================
  // Meta
  // =========================
  const VERSION = '2.0.1';
  const LOG_PREFIX = '[CCF .gachaRS]';

  // 二重ロード防止
  if (window.__CCF_GACHARS_CORE_V2_LOADED__) {
    console.log(`${LOG_PREFIX} v${VERSION}（core）は既にロード済みです↩️`);
    return;
  }
  window.__CCF_GACHARS_CORE_V2_LOADED__ = true;

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

  // 待機（要件：各貼り付け動作やmove動作の前に 0.5秒）
  const STEP_WAIT_MS = 500;

  // DB（単一）
  const DB_URL = 'https://raw.githubusercontent.com/4bxy/SWmonsterDB/refs/heads/main/gachaRS.json';

  // localStorage cache key
  const DB_CACHE_KEY = '__CCF_GACHARS_DB_JSON__';
  const DB_CACHE_META_KEY = '__CCF_GACHARS_DB_META__'; // { savedAt:number, version:any, count:any }

  // 再発火防止（/add式 “時刻参照チェック” の代替：時刻+発言者+本文 をキー化して保存）
  const PROCESSED_KEY = '__CCF_GACHARS_PROCESSED__'; // JSON: { [key:string]: number(lastSeenMs) }
  const PROCESSED_TTL_MS = 10 * 60 * 1000; // 10分残す（リロード/再描画対策）
  const PROCESSED_MAX_KEYS = 300;

  // .move相当：5つの配置座標（ボード座標）
  const LAYOUT_XY = [
    { x: -240, y: -240 },
    { x: -120, y: -240 },
    { x: 0, y: -240 },
    { x: 120, y: -240 },
    { x: 240, y: -240 },
  ];

  // 召喚駒の固定サイズ
  const TOKEN_SIZE = { width: 7, height: 7 };

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
    // 1..100
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
  // Memo builder (指定フォーマット)
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
  // Clipboard + Paste ('.call' 相当を内蔵)
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
  // Move ('.move' 相当を内蔵)
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
    // Clipboard API: hideStatus は boolean で指定可 :contentReference[oaicite:1]{index=1}
    const base = item?.ccfoliaPaste && typeof item.ccfoliaPaste === 'object'
      ? JSON.parse(JSON.stringify(item.ccfoliaPaste))
      : { kind: 'character', data: {} };

    if (!base.data || typeof base.data !== 'object') base.data = {};
    base.kind = base.kind || 'character';

    const rawName = (item?.name ?? base.data.name ?? 'アイテム').toString();
    const nameWithRarity = `【★${rarity}】${rawName}`;

    base.data.name = nameWithRarity;
    base.data.memo = buildMemoFromItem(item, ownerName);

    // 画像リンク空なら iconUrl 自体を作らない
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

    // 余計な表示を増やさない（必要ならDB側で持たせるが、今回は空に寄せる）
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
    const cand = container.querySelector('time')?.textContent?.trim();
    if (cand) return cand;
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

  // ★ 改修：本文ではなく “発言者表示” を取りにいく
  function extractSpeakerName(container, messageText) {
    if (!container) return '';

    // 1) まず primary 系の定番を狙う
    const primary =
      container.querySelector('p.MuiListItemText-primary')?.textContent ||
      container.querySelector('span.MuiListItemText-primary')?.textContent ||
      container.querySelector('p[class*="primary"]')?.textContent ||
      container.querySelector('span[class*="primary"]')?.textContent ||
      '';

    let name = normalizeName(primary);

    // 「4bxy - 今日 1:41」みたいな表記なら左側だけ取る
    if (name.includes(' - ')) name = normalizeName(name.split(' - ')[0]);

    // 2) それでも取れない / 本文と同じになった場合のフォールバック
    // 例：誤って secondary を拾うと ".gachaRS" になりがちなので、それを弾く
    if (!name || name === messageText || name === COMMAND) {
      // container内のテキスト要素を総当たりで拾い、本文/時刻っぽいものを除外して候補にする
      const elems = Array.from(container.querySelectorAll('p,span,div'));
      const candidates = [];

      for (const el of elems) {
        const t = normalizeName(el.textContent || '');
        if (!t) continue;
        if (t === messageText) continue;
        if (t === COMMAND) continue;

        // 時刻っぽいものを除外（「今日 1:41」「12:34」など）
        if (/^\d{1,2}:\d{2}$/.test(t)) continue;
        if (/(今日|昨日|明日)\s*\d{1,2}:\d{2}/.test(t)) continue;

        // 「name - 今日 1:41」形式なら左側
        let n = t;
        if (n.includes(' - ')) n = normalizeName(n.split(' - ')[0]);

        // あまり長すぎるのは説明文の可能性が高いので弾く（名前は通常短い）
        if (n.length > 40) continue;

        candidates.push(n);
      }

      // 一番最初に現れる妥当候補を採用
      if (candidates.length > 0) name = candidates[0];
    }

    return normalizeName(name);
  }

  function makeProcessedKey(container, messageText) {
    const timeText = extractTimeText(container) || '';
    const speaker = extractSpeakerName(container, messageText) || '';
    const body = messageText || '';
    return `${timeText}__${speaker}__${body}`.slice(0, 500);
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

      // 貼り付け前 0.5s
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

      // move前 0.5s
      await sleep(STEP_WAIT_MS);

      const pos = LAYOUT_XY[i] || LAYOUT_XY[LAYOUT_XY.length - 1] || { x: 0, y: 0 };
      const okMove = await moveOneTokenByNameToXY(tokenName, pos.x, pos.y, beforeSet);
      console.log(`${LOG_PREFIX} move ${okMove ? 'OK' : 'NG'}:`, tokenName, '=>', pos);
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

    if (msgText.trim() !== COMMAND) return;

    const p = getMsgBodyP(node);
    const container = getMsgContainerFromBodyP(p) || node.closest?.('div.MuiListItem-root, li.MuiListItem-root') || null;

    const key = makeProcessedKey(container, msgText);

    if (isAlreadyProcessed(key)) {
      processedNodes.add(node);
      console.debug(`${LOG_PREFIX} 再発火防止で無視:`, key);
      return;
    }

    processedNodes.add(node);
    markProcessed(key);

    // ★ 改修：所有者は “発言者表示” から取る
    const speaker = extractSpeakerName(container, msgText) || '不明';

    console.log(`${LOG_PREFIX} 検知:`, { command: msgText, speaker });

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
