/* CCF .call v2.0.0
 * - Tampermonkey から @require で読み込まれる GitHub core
 */

(function () {
  'use strict';

  // 二重ロード防止（@requireの再評価や手動実行の事故対策）
  if (window.__CCF_CALL_CORE_V2_LOADED__) return;
  window.__CCF_CALL_CORE_V2_LOADED__ = true;

  const VERSION = '2.0.0';
  const LOG = `[CCF .call v${VERSION}]`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  console.log(`🚀 ${LOG} loaded (GitHub core)`);

  // ============================================================
  // ======================== 設定値 ============================
  // ============================================================

  const COMMAND_PREFIX = '.call';
  const MAX_COUNT = 10;
  const MULTI_DELAY_MS = 500; // 1体ごとの貼り付け間隔

  // === GitHub上のDB設定 ===
  const GITHUB_DB_URL = 'https://raw.githubusercontent.com/4bxy/SWmonsterDB/refs/heads/main/monsterDBv8.json';

  // localStorageのキー
  const DB_STORAGE_KEY = 'ccf_call_monsterDB_json';
  const DB_SCRIPT_VER_KEY = 'ccf_call_monsterDB_scriptVersion';

  // 実際に使うDB本体
  let monsterDB = [];

  // 「前回うまく貼り付けできた画面上の座標」をキャッシュ
  let lastSuccessPoint = null;

  // ============================================================
  // ====== GitHubからDBを取得 & ローカルキャッシュ =============
  // ============================================================

  async function fetchMonsterDBFromGitHub() {
    try {
      console.log(LOG, 'GitHub から monsterDB を取得開始:', GITHUB_DB_URL);
      const res = await fetch(GITHUB_DB_URL, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error('取得した JSON が配列ではありません');
      }
      console.log(LOG, `GitHub から ${data.length} 件のレコードを取得`);
      return data;
    } catch (e) {
      console.error(LOG, 'GitHub から魔物DBの取得に失敗:', e);
      return null;
    }
  }

  async function initMonsterDB() {
    try {
      const cachedJson = localStorage.getItem(DB_STORAGE_KEY);
      const cachedVer = localStorage.getItem(DB_SCRIPT_VER_KEY);

      // 同じスクリプトバージョンならローカルキャッシュをそのまま使用
      if (cachedJson && cachedVer === VERSION) {
        try {
          const parsed = JSON.parse(cachedJson);
          if (Array.isArray(parsed)) {
            monsterDB = parsed;
            console.log(LOG, `monsterDB を localStorage から読み込み完了 (${monsterDB.length} 件, script v${VERSION})`);
            return;
          } else {
            console.warn(LOG, 'localStorage の monsterDB が配列ではありません。再取得します。');
          }
        } catch (e) {
          console.warn(LOG, 'localStorage の monsterDB JSON パースに失敗。再取得します。', e);
        }
      }

      // ここまで来たら GitHub から取り直す（初回 or スクリプト更新）
      const remoteData = await fetchMonsterDBFromGitHub();
      if (remoteData && Array.isArray(remoteData)) {
        monsterDB = remoteData;
        localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(remoteData));
        localStorage.setItem(DB_SCRIPT_VER_KEY, VERSION);
        console.log(LOG, `monsterDB を GitHub から取得し localStorage に保存 (${monsterDB.length} 件, script v${VERSION})`);
        return;
      }

      // どうしても無理だった場合
      if (!monsterDB || monsterDB.length === 0) {
        console.warn(LOG, 'monsterDB が空です（GitHub取得も失敗）。.call は常に「該当魔物なし」になります。');
      }
    } catch (e) {
      console.error(LOG, 'initMonsterDB 中にエラー:', e);
    }
  }

  const dbReadyPromise = initMonsterDB();

  // ============================================================
  // ====== .del 相当：編集→空→保存 ユーティリティ ===============
  // ============================================================

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

  function getMsgBodyP(node) {
    if (!(node instanceof HTMLElement)) return null;
    if (node.matches && node.matches('p.MuiListItemText-secondary')) return node;
    return node.querySelector?.('p.MuiListItemText-secondary') || null;
  }
  function getMsgContainerFromBodyP(p) {
    return p?.closest('div.MuiListItem-root') || p?.closest('li.MuiListItem-root') || null;
  }
  function findPenButtonInContainer(container) {
    if (!container) return null;
    const candidates = container.querySelectorAll('button.MuiIconButton-root');
    for (const btn of candidates) {
      if (btn.querySelector('svg[data-testid="EditIcon"]')) return btn;
    }
    const fab = container.querySelector('button.MuiFab-root svg[data-testid="EditIcon"]');
    return fab ? fab.closest('button') : null;
  }
  function revealHoverUI(el) {
    ['mouseenter', 'mouseover', 'mousemove'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 1, clientY: 1 }));
    });
  }
  async function clickEditPenForMessage(rootElContainingText) {
    const p = getMsgBodyP(rootElContainingText);
    if (!p) return false;
    const container = getMsgContainerFromBodyP(p);
    if (!container) return false;

    revealHoverUI(container);
    await sleep(40);

    const pen = findPenButtonInContainer(container);
    if (!pen) return false;
    pen.click();
    return true;
  }
  function findEditDrawerRoot() {
    const saveBtn = Array.from(document.querySelectorAll('button'))
      .find(b => /保存/.test(b.textContent || ''));
    if (!saveBtn) return null;

    let p = saveBtn.parentElement;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      if (p.querySelector('textarea.MuiInputBase-inputMultiline')) return p;
    }
    return document;
  }
  function findEditTextarea(root) {
    return root.querySelector('textarea.MuiInputBase-inputMultiline[placeholder="メッセージを入力"]')
      || root.querySelector('textarea.MuiInputBase-inputMultiline')
      || root.querySelector('textarea');
  }
  function findSaveButton(root) {
    return Array.from(root.querySelectorAll('button')).find(b => /保存/.test(b.textContent || ''));
  }
  async function emptyAndSaveViaEditTab_NoDelay() {
    for (let i = 0; i < 30; i++) {
      const root = findEditDrawerRoot();
      if (root) {
        const ta = findEditTextarea(root);
        const save = findSaveButton(root);
        if (ta && save) {
          simulateInput(ta, '');
          save.click();
          return true;
        }
      }
      await sleep(50);
    }
    return false;
  }
  function isInDocument(node) {
    return node && node.isConnected;
  }

  const selfDeleteScheduled = new WeakMap();
  const selfDeleteFinished = new WeakSet();

  function scheduleSelfDeletion(node, afterMs = 1000) {
    if (!(node instanceof HTMLElement)) return;
    if (selfDeleteFinished.has(node)) return;
    if (selfDeleteScheduled.has(node)) return;

    const id = setTimeout(async () => {
      selfDeleteScheduled.delete(node);
      if (!isInDocument(node)) return;

      const penOk = await clickEditPenForMessage(node);
      if (!penOk) {
        console.debug(LOG, 'self-delete: ペン要素が見つからない/クリック失敗');
        return;
      }
      const saveOk = await emptyAndSaveViaEditTab_NoDelay();
      if (!saveOk) {
        console.warn(LOG, 'self-delete: 編集ドロワ操作失敗（textarea/保存 未検出）');
        return;
      }
      selfDeleteFinished.add(node);
      console.log(LOG, `self-delete: ${afterMs}ms後に空保存完了（実質削除）`);
    }, afterMs);

    selfDeleteScheduled.set(node, id);
    console.log(LOG, `self-delete を ${afterMs}ms 後にスケジュール`);
  }

  // ============================================================
  // ====== 画面上の複数座標で右クリックし、「貼り付け」を探す =====
  // ============================================================

  function closeAnyMenuByEsc() {
    const active = document.activeElement || document.body;
    active.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));
    active.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));
  }

  async function tryContextMenuAtPoint(x, y, maxWaitMs = 700) {
    const target = document.elementFromPoint(x, y);
    if (!target) {
      console.debug(LOG, 'elementFromPoint で要素が取得できず:', x, y);
      return false;
    }

    console.debug(LOG, '右クリック試行 target:', target.tagName, 'at', x, y);

    ['mousedown', 'mouseup', 'contextmenu'].forEach(type => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        which: 3,
        clientX: x,
        clientY: y,
      }));
    });

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const menus = document.querySelectorAll('ul[role="menu"], ul.MuiMenu-list');
      for (const menu of menus) {
        const items = menu.querySelectorAll('li.MuiMenuItem-root, li[role="menuitem"]');
        for (const li of items) {
          const text = (li.textContent || '').trim();
          if (!text) continue;
          if (text.includes('貼り付け')) {
            console.log(LOG, 'コンテキストメニュー内の「貼り付け」をクリック:', text);
            li.click();
            return true;
          }
        }
      }
      await sleep(50);
    }

    closeAnyMenuByEsc();
    return false;
  }

  async function triggerContextPasteMultiPoint() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    const points = [
      [w * 0.10, h * 0.92], // 左下
      [w * 0.50, h * 0.08], // 上中央
      [w * 0.82, h * 0.50], // 右寄り中央
      [w * 0.32, h * 0.30], // ステージ左上寄り
      [w * 0.68, h * 0.30], // ステージ右上寄り
      [w * 0.50, h * 0.50], // 中央
      [w * 0.40, h * 0.50], // 中央やや左
    ];

    if (lastSuccessPoint) {
      const { x, y } = lastSuccessPoint;
      const ok = await tryContextMenuAtPoint(x, y, 500);
      if (ok) {
        console.log(LOG, 'lastSuccessPoint で貼り付け成功:', x, y);
        return;
      } else {
        console.log(LOG, 'lastSuccessPoint では貼り付け失敗。座標再探索へ:', x, y);
      }
    }

    for (const [x, y] of points) {
      const ok = await tryContextMenuAtPoint(x, y, 700);
      if (ok) {
        console.log(LOG, '右クリック座標', x, y, 'で「貼り付け」に成功');
        lastSuccessPoint = { x, y };
        return;
      }
    }

    console.warn(LOG, '複数座標を試したが「貼り付け」メニューを取得できず');
  }

  // ============================================================
  // ====== 剣の欠片（-sN）処理ユーティリティ ====================
  // ============================================================

  function calcShardResistBonus(s) {
    if (!Number.isFinite(s) || s <= 0) return 0;
    if (s <= 5) return 1;
    if (s <= 10) return 2;
    if (s <= 15) return 3;
    return 4;
  }

  // memo の「生命抵抗力:～　精神抵抗力:～」行を、params から再計算した値で更新
  // shardCount > 0 のときは先頭に「★〈剣のかけら〉N個」を挿入（または置き換え）
  function updateMemoResistsFromParams(data, shardCount) {
    if (!data) return;
    if (typeof data.memo !== 'string') return;
    if (!Array.isArray(data.params)) return;

    const vitParam = data.params.find(p => p && p.label === '生命抵抗力');
    const menParam = data.params.find(p => p && p.label === '精神抵抗力');

    const vitStr = vitParam?.value ?? '';
    const menStr = menParam?.value ?? '';

    const vitInt = parseInt(vitStr, 10);
    const menInt = parseInt(menStr, 10);

    const vitPlus = Number.isFinite(vitInt) ? String(vitInt + 7) : '';
    const menPlus = Number.isFinite(menInt) ? String(menInt + 7) : '';

    const lines = data.memo.split('\n');

    // ★〈剣のかけら〉N個 の行を先頭に仕込む（-sなしなら何もしない）
    if (shardCount > 0) {
      const labelLine = `★〈剣のかけら〉${shardCount}個`;
      let foundIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('★〈剣のかけら〉')) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx >= 0) {
        lines[foundIdx] = labelLine;
      } else {
        lines.unshift(labelLine);
      }
    }

    // 抵抗力行の置き換え
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('生命抵抗力:')) {
        lines[i] = `生命抵抗力:${vitStr} (${vitPlus})　精神抵抗力:${menStr} (${menPlus})`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.push(`生命抵抗力:${vitStr} (${vitPlus})　精神抵抗力:${menStr} (${menPlus})`);
    }

    data.memo = lines.join('\n');
  }

  function applySwordShardsToRecord(rec, shardCount) {
    const data = rec && rec.data;
    if (!data || !Array.isArray(data.status) || shardCount <= 0) return;

    // ① 抵抗力強化
    const resistBonus = calcShardResistBonus(shardCount);
    if (resistBonus > 0 && Array.isArray(data.params)) {
      data.params = data.params.map(p => {
        if (!p) return p;
        const label = p.label;
        let value = p.value;
        if (typeof value !== 'string') return p;
        if (label === '生命抵抗力' || label === '精神抵抗力') {
          const v = parseInt(value, 10);
          if (Number.isFinite(v)) {
            return { ...p, value: String(v + resistBonus) };
          }
        }
        return p;
      });
    }

    // ② HP/MP強化
    const status = data.status;
    const hpEntries = [];
    const mpMap = new Map(); // partIdx -> status index

    status.forEach((st, idx) => {
      if (!st || typeof st.label !== 'string') return;
      const label = st.label;
      const hpMatch = /^HP(\d+)$/.exec(label);
      if (hpMatch) {
        const partIdx = parseInt(hpMatch[1], 10);
        if (Number.isFinite(partIdx)) {
          hpEntries.push({ idx, partIdx });
        }
        return;
      }
      const mpMatch = /^MP(\d+)$/.exec(label);
      if (mpMatch) {
        const partIdx = parseInt(mpMatch[1], 10);
        if (Number.isFinite(partIdx)) {
          mpMap.set(partIdx, idx);
        }
      }
    });

    if (hpEntries.length === 0) {
      // 抵抗力だけ更新したので memo だけ更新して終了
      if (resistBonus > 0) {
        updateMemoResistsFromParams(data, shardCount);
      }
      return;
    }

    // 部位番号順にソート
    hpEntries.sort((a, b) => a.partIdx - b.partIdx);
    const parts = hpEntries.map(e => e.partIdx);
    const nParts = parts.length;

    const base = Math.floor(shardCount / nParts);
    const remainder = shardCount % nParts;

    for (let j = 0; j < nParts; j++) {
      const partIdx = parts[j];
      let sForPart = base;
      // 余りは第一部位（最小の部位番号）に振る
      if (j === 0) sForPart += remainder;
      if (sForPart <= 0) continue;

      const hpInc = 5 * sForPart;
      const mpInc = sForPart;

      // HP調整
      const hpStatusIdx = hpEntries[j].idx;
      const hpStatus = status[hpStatusIdx];
      if (hpStatus) {
        const v = parseInt(hpStatus.value, 10);
        const m = parseInt(hpStatus.max, 10);
        if (Number.isFinite(v)) hpStatus.value = String(v + hpInc);
        if (Number.isFinite(m)) hpStatus.max = String(m + hpInc);
      }

      // MP調整（元からMPがある部位のみ）
      const mpStatusIdx = mpMap.get(partIdx);
      if (mpStatusIdx != null) {
        const mpStatus = status[mpStatusIdx];
        if (mpStatus) {
          const v = parseInt(mpStatus.value, 10);
          const m = parseInt(mpStatus.max, 10);
          if (Number.isFinite(v)) mpStatus.value = String(v + mpInc);
          if (Number.isFinite(m)) mpStatus.max = String(m + mpInc);
        }
      }
    }

    // ③ memo 内の抵抗力行・剣のかけら行を更新
    if (resistBonus > 0) {
      updateMemoResistsFromParams(data, shardCount);
    }
  }

  // ============================================================
  // =================== .call のパース & 実行 ===================
  // ============================================================

  function clampCount(n) {
    if (!Number.isFinite(n)) return 1;
    n = Math.floor(n);
    if (n < 1) return 1;
    if (n > MAX_COUNT) return MAX_COUNT;
    return n;
  }

  function parseCallCommand(fullText) {
    const m = fullText.match(/^\s*\.call\b(.*)$/);
    if (!m) return null;
    const rest = (m[1] || '').trim();
    if (!rest) return null;

    let tokens = rest.split(/\s+/);
    let initiative = null;
    let count = 1;
    let shardCount = 0;

    // -sN オプションを抜き取って合算
    const tmp = [];
    for (const t of tokens) {
      const ms = t.match(/^-s(\d+)$/);
      if (ms) {
        const v = parseInt(ms[1], 10);
        if (Number.isFinite(v) && v > 0) {
          shardCount += v;
        }
      } else {
        tmp.push(t);
      }
    }
    tokens = tmp;

    // ここから従来のイニシアティブ/連続数解析
    if (tokens.length >= 3) {
      const last = tokens[tokens.length - 1];
      const prev = tokens[tokens.length - 2];

      const lastIsInt = /^[+-]?\d+$/.test(last);
      const prevIsInt = /^[+-]?\d+$/.test(prev);

      if (lastIsInt && prevIsInt) {
        const rawCount = parseInt(last, 10);
        const rawInit = parseInt(prev, 10);
        initiative = rawInit;
        count = clampCount(rawCount);
        tokens.pop();
        tokens.pop();
      } else if (lastIsInt) {
        initiative = parseInt(last, 10);
        count = 1;
        tokens.pop();
      }
    } else if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1];
      if (/^[+-]?\d+$/.test(last)) {
        initiative = parseInt(last, 10);
        count = 1;
        tokens.pop();
      }
    }

    const name = tokens.join(' ').trim();
    if (!name) return null;

    if (initiative == null) {
      count = 1;
    }

    return { name, initiative, count, shardCount };
  }

  function findMonsterByName(name) {
    for (const rec of monsterDB) {
      const recName = rec?.data?.name;
      if (recName === name) return rec;
    }
    return null;
  }

  function suffixLetter(index) {
    const base = 'A'.charCodeAt(0);
    return String.fromCharCode(base + index);
  }

  async function runCallSequence(baseRec, baseName, initiative, count, shardCount) {
    for (let i = 0; i < count; i++) {
      const cloned = JSON.parse(JSON.stringify(baseRec));
      if (!cloned.data) cloned.data = {};

      // 名前：†と連番を付ける
      let finalName = baseName || cloned.data.name || '';
      if (shardCount > 0) {
        if (!finalName.includes('†')) {
          finalName += '†';
        }
      }
      if (count > 1) {
        const sfx = suffixLetter(i);
        finalName += sfx;
      }
      cloned.data.name = finalName;

      // イニシアティブ
      if (typeof initiative === 'number') {
        cloned.data.initiative = initiative - i;
      }

      // 剣の欠片強化
      if (shardCount > 0) {
        applySwordShardsToRecord(cloned, shardCount);
      }

      const jsonText = JSON.stringify(cloned);

      // v2 core は @grant none なので navigator.clipboard を使用
      try {
        await navigator.clipboard.writeText(jsonText);
      } catch (e) {
        console.warn(LOG, 'navigator.clipboard で書き込み失敗。HTTPS/権限/ブラウザ制約の可能性:', e);
        // ここでフォールバックを無理に実装すると危険（権限やUI依存が強い）なので、ログのみ。
      }

      console.log(
        LOG,
        `JSON をクリップボードへ書き込み:`,
        cloned.data?.name,
        'initiative=',
        cloned.data?.initiative,
        'shard=',
        shardCount,
        `(${i + 1}/${count})`
      );

      try {
        await triggerContextPasteMultiPoint();
      } catch (e) {
        console.error(LOG, '右クリック貼り付け処理中にエラー:', e);
      }

      if (i < count - 1) {
        await sleep(MULTI_DELAY_MS);
      }
    }
  }

  function handleCall(fullText, sourceNode) {
    const parsed = parseCallCommand(fullText);
    if (!parsed) {
      console.warn(LOG, 'コマンド解析に失敗:', fullText);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }

    const { name, initiative, count, shardCount } = parsed;
    console.log(LOG, '解析結果 name=', name, 'initiative=', initiative, 'count=', count, 'shard=', shardCount);

    const baseRec = findMonsterByName(name);
    if (!baseRec) {
      console.warn(LOG, '該当魔物がDBに存在しません:', name);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }

    const baseName = baseRec?.data?.name || name;

    if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);

    (async () => {
      await runCallSequence(baseRec, baseName, initiative, count, shardCount);
    })();
  }

  // ============================================================
  // ======================== Chat監視 ===========================
  // ============================================================

  const processedNodes = new WeakSet();

  function handleNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (processedNodes.has(node)) return;

    const text = node.innerText?.trim();
    if (!text) return;
    if (!text.startsWith(COMMAND_PREFIX)) return;

    processedNodes.add(node);
    console.log(LOG, '検知:', text);

    (async () => {
      try {
        await dbReadyPromise;
        handleCall(text, node);
      } catch (e) {
        console.error(LOG, '.call 処理前の DB 初期化待機中にエラー:', e);
      }
    })();
  }

  function observeChat() {
    const chatRoot =
      document.querySelector('[data-testid="chat-message-list"]') ||
      document.querySelector('[class*="MuiList-root"]') ||
      document.querySelector('[data-rbd-droppable-id="messages"]');

    if (!chatRoot) return false;

    const obs = new MutationObserver(muts => {
      muts.forEach(m => {
        m.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          handleNode(node);
          node.querySelectorAll?.('*')?.forEach?.(el => handleNode(el));
        });
      });
    });
    obs.observe(chatRoot, { childList: true, subtree: true });

    // 既存メッセージも走査
    chatRoot.querySelectorAll?.('li,div').forEach(handleNode);

    console.log(LOG, `監視開始（.call v${VERSION} core）`);
    return true;
  }

  function boot() {
    const ok = observeChat();
    if (ok) return;

    const iv = setInterval(() => {
      const exists =
        document.querySelector('[data-testid="chat-message-list"]') ||
        document.querySelector('p.MuiListItemText-secondary');
      if (exists) {
        clearInterval(iv);
        observeChat();
      }
    }, 800);
  }

  window.addEventListener('load', boot);

  // 手動テスト用（任意）
  window.__CCF_CALL_CORE__ = {
    VERSION,
    handleCall,
    parseCallCommand,
  };
})();
