/* CCFOLIA .gachaRS core v0.1.2
 * Fixes:
 *  ① owner名が「名前.gachaRS」になる混入を除去（sanitize）
 *  ② /add v2.0.2 と同型の「時刻参照 + 指紋hash + sessionStorage」誤爆防止へ刷新
 *  ③ 座標は“中心指定”でハードコードし、実配置は左上基準に合わせて (x,y) に -12*駒サイズ を自動オフセット
 *  ④ VERSION は 0.1.2（未完成版）
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
  // /add v2.0.2式：誤爆防止（時刻参照 + 指紋hash + sessionStorage）
  // =========================
  const STORAGE_KEY = '__CCF_GACHARS_V0_PROCESSED__';
  const processed = new Set(loadProcessedFromSession());

  function loadProcessedFromSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveProcessedToSession() {
    try {
      const arr = Array.from(processed);
      const sliced = arr.slice(Math.max(0, arr.length - 500)); // 肥大化防止
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sliced));
    } catch {
      // sessionStorage不可でも動作は継続
    }
  }

  // =========================
  // Layout（中心指定）
  // =========================
  const LAYOUT_CENTER_XY = [
    { x: -240, y: -240 },
    { x: -120, y: -240 },
    { x: 0, y: -240 },
    { x: 120, y: -240 },
    { x: 240, y: -240 },
  ];

  // 召喚駒の固定サイズ
  const TOKEN_SIZE = { width: 7, height: 7 };

  // ココフォリアの駒座標は「左上」基準なので、中心指定から左上へ補正する
  // 要件：x,yともに -12*駒サイズ
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
    return (s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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

  function hashString(s) {
    // /add v2.0.2 と同じ djb2-ish
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h >>>= 0;
    }
    return `h${h.toString(16)}`;
  }

  function getNowHHMM() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
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
  // Clipboard + Paste
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

    // ステータス非表示 + 空
    base.data.hideStatus = true;
    base.data.status = [];
    base.data.params = [];

    base.data.commands = '';
    base.data.initiative = base.data.initiative ?? 0;
    base.data.externalUrl = base.data.externalUrl ?? '';

    return base;
  }

  // =========================
  // /add v2.0.2 方式：投稿1件の要素を確実に掴む
  // =========================
  function getMessageItemElement(fromNode) {
    if (!(fromNode instanceof HTMLElement)) return null;

    const closest = fromNode.closest?.('[class*="MuiListItem-root"]');
    if (closest) return closest;

    const inner = fromNode.querySelector?.('[class*="MuiListItem-root"]');
    return inner || null;
  }

  // =========================
  // 所有者抽出（/add同型） + 混入除去
  // =========================
  function sanitizeOwnerName(name) {
    let n = normalizeName(name);

    // 末尾に ".gachaRS" が混入したら除去（スペース無し連結も含む）
    // 例: "4bxy.gachaRS" / "4bxy .gachaRS"
    n = n.replace(new RegExp(`\\s*\\.?${COMMAND.replace('.', '')}\\s*$`, 'i'), '');
    n = n.replace(/\.$/, '');

    return normalizeName(n);
  }

  function extractCharNameFromItem(item) {
    const h6 = item.querySelector('h6.MuiTypography-root');
    if (!h6) return '（不明なキャラ）';

    const caption = h6.querySelector('span.MuiTypography-caption');
    const full = normalizeName(h6.innerText || '');
    const cap = normalizeName(caption?.innerText || '');

    const name = cap ? normalizeName(full.replace(cap, '').replace(/-$/, '')) : full;
    return sanitizeOwnerName(name || '（不明なキャラ）');
  }

  function getTimeLabelFromItem(item) {
    const h6 = item.querySelector('h6.MuiTypography-root');
    const cap = h6?.querySelector('span.MuiTypography-caption');
    if (!cap) return null;

    let t = normalizeName(cap.innerText || '');
    t = t.replace(/^[\s-]+/, '').trim(); // 先頭の "-" や空白を落とす
    return t || null;
  }

  // 「今日 HH:MM」かつ “今の分” だけ処理（過去ログ暴発を切る主軸）
  function shouldProcessByTime(item) {
    const label = getTimeLabelFromItem(item);
    if (!label) return false;

    const m = label.match(/^今日\s+(\d{1,2}:\d{2})$/);
    if (!m) return false;

    const msgHHMM = m[1].replace(/^(\d):/, '0$1:'); // 9:05 -> 09:05
    return msgHHMM === getNowHHMM();
  }

  function makeFingerprint(item, fullText) {
    const name = extractCharNameFromItem(item);
    const timeLabel = getTimeLabelFromItem(item) || '';
    const base = `${name}@@${timeLabel}@@${fullText}`.slice(0, 2000);
    return hashString(base);
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

      // 中心座標 → 左上座標へ補正
      const center = LAYOUT_CENTER_XY[i] || LAYOUT_CENTER_XY[LAYOUT_CENTER_XY.length - 1] || { x: 0, y: 0 };
      const pos = { x: center.x + TOPLEFT_OFFSET.x, y: center.y + TOPLEFT_OFFSET.y };

      const okMove = await moveOneTokenByNameToXY(tokenName, pos.x, pos.y, beforeSet);
      console.log(`${LOG_PREFIX} move ${okMove ? 'OK' : 'NG'}:`, tokenName, 'center=>', center, 'topleft=>', pos);
    }

    console.log(`${LOG_PREFIX} 5連処理完了✅`);
  }

  // =========================
  // 監視（/add v2.0.2 型）
  // =========================
  function observeChat() {
    const chatRoot = document.querySelector('[class*="MuiList-root"]') ||
      document.querySelector('[data-testid="chat-message-list"]') ||
      document.querySelector('[data-rbd-droppable-id="messages"]');

    if (!chatRoot) return false;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          const item = getMessageItemElement(added);
          if (!item) continue;

          const fullTextRaw = item.innerText || '';
          const fullText = normalizeText(fullTextRaw);

          // コマンドが含まれないなら無視（高速化）
          // 例：「4bxy - 今日 2:34\n.gachaRS」
          if (!new RegExp(`(^|\\n)\\s*${COMMAND.replace('.', '\\.')}\\s*(\\n|$)`, 'i').test(fullText)) {
            continue;
          }

          // 時刻フィルタ（過去ログ暴発を切る主軸）
          if (!shouldProcessByTime(item)) continue;

          // 同一分リロード対策：sessionStorage 指紋
          const fp = makeFingerprint(item, fullText);
          if (processed.has(fp)) continue;

          processed.add(fp);
          saveProcessedToSession();

          const owner = extractCharNameFromItem(item) || '不明';

          console.log(`${LOG_PREFIX} v${VERSION} .gachaRS検知→実行します📦`, {
            owner,
            time: getTimeLabelFromItem(item),
            fp,
          });

          // 同時実行防止
          if (isRunning) {
            console.warn(`${LOG_PREFIX} 既に実行中のため、この .gachaRS は無視します（衝突防止）`);
            continue;
          }

          (async () => {
            isRunning = true;
            try {
              await runGacha5(owner);
            } catch (e) {
              console.error(`${LOG_PREFIX} 実行エラー:`, e);
            } finally {
              isRunning = false;
            }
          })();
        }
      }
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
    console.log(`${LOG_PREFIX} v${VERSION} 監視を開始しました✅`);
    return true;
  }

  // ===== 起動待ち（無限待ちしない） =====
  window.addEventListener('load', () => {
    const startAt = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - startAt > 60_000) {
        clearInterval(interval);
        console.warn(`${LOG_PREFIX} v${VERSION} チャット要素を見つけられず監視開始できませんでした⚠️`);
        return;
      }
      if (observeChat()) clearInterval(interval);
    }, 500);
  });

  // DB先読み
  initDb().then((ok) => {
    if (ok) console.log(`${LOG_PREFIX} DB先読み完了✅`);
  });

})();
