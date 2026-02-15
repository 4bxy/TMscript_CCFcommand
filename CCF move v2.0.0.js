/* CCF .move v2.0.0
 * - TMから読み込む GitHub core
 * - .execute v2.0.0 と同じ形式（core + loader）
 */

(function () {
  'use strict';

  // 二重ロード防止（@requireの再評価や手動実行の事故対策）
  if (window.__CCF_MOVE_CORE_V2_LOADED__) return;
  window.__CCF_MOVE_CORE_V2_LOADED__ = true;

  const VERSION = '2.0.0';
  const LOG = `[CCF .move v${VERSION}]`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  console.log(`🚀 ${LOG} loaded (GitHub core)`);

  const COMMAND_PREFIX = '.move';

  // ============================================================
  // ========== .call から流用：編集→空→保存で自己削除 ==========
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
    // .execute v2.0.0 core同様、ここは静かめ運用（ログ多すぎ対策）
    // console.log(LOG, `self-delete を ${afterMs}ms 後にスケジュール`);
  }

  // ============================================================
  // ======================= .move 本体 ==========================
  // ============================================================

  function normalizeName(s) {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  function parseNumberToken(tok) {
    // returns {kind:'abs'|'rel', value:number} or null
    // abs:  200, -293, 0, 12.5
    // rel:  ~10, ~-10, ~0, ~12.5
    if (typeof tok !== 'string') return null;
    tok = tok.trim();
    if (!tok) return null;

    const rel = tok.startsWith('~');
    const numPart = rel ? tok.slice(1) : tok;

    if (!/^[+-]?\d+(\.\d+)?$/.test(numPart)) return null;
    const v = Number(numPart);
    if (!Number.isFinite(v)) return null;

    return { kind: rel ? 'rel' : 'abs', value: v };
  }

  function parseMoveCommand(fullText) {
    // 仕様:
    // 1) .move <駒名> <x> <y>   … x/yは abs or rel(~)
    // 2) .move <駒名>           … 特殊（画面中央へ：x=y=-(駒サイズ*12)）
    // ※ 特殊は「駒名が1トークンのみ」のときだけ（スペース含む名前は通常形式で）
    const m = fullText.match(/^\s*\.move\b(.*)$/);
    if (!m) return null;

    const rest = (m[1] || '').trim();
    if (!rest) return null;

    const tokens = rest.split(/\s+/).filter(Boolean);

    if (tokens.length === 1) {
      return { mode: 'center', name: tokens[0] };
    }

    if (tokens.length >= 3) {
      const yTok = tokens[tokens.length - 1];
      const xTok = tokens[tokens.length - 2];

      const px = parseNumberToken(xTok);
      const py = parseNumberToken(yTok);
      if (!px || !py) return { mode: 'invalid' };

      const name = tokens.slice(0, -2).join(' ').trim();
      if (!name) return { mode: 'invalid' };

      return { mode: 'xy', name, xSpec: px, ySpec: py };
    }

    return { mode: 'invalid' };
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
  }

  function findPieceMovableByName(name) {
    const target = normalizeName(name);
    const movables = Array.from(document.querySelectorAll('div.movable')).filter(isVisible);

    for (const mv of movables) {
      const sp = mv.querySelector('span');
      const t = normalizeName(sp?.textContent || '');
      if (t === target) return mv;
    }

    for (const mv of movables) {
      const sp = mv.querySelector('span.MuiTypography-caption, span[class*="MuiTypography-caption"]');
      const t = normalizeName(sp?.textContent || '');
      if (t === target) return mv;
    }

    for (const mv of movables) {
      const sp = mv.querySelector('span');
      const t = normalizeName(sp?.textContent || '');
      if (t && (t.includes(target) || target.includes(t))) return mv;
    }

    return null;
  }

  async function rightClickAndClickMenuItemAtPoint(x, y, includeText, maxWaitMs = 700) {
    const targetEl = document.elementFromPoint(x, y);
    if (!targetEl) return false;

    ['mousedown', 'mouseup', 'contextmenu'].forEach(type => {
      targetEl.dispatchEvent(new MouseEvent(type, {
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

  function findSizeInput(dialog) {
    if (!dialog) return null;

    const direct = dialog.querySelector('input[name="size"], input[name="pieceSize"], input[name="tokenSize"], input[aria-label="駒サイズ"]');
    if (direct) return direct;

    const labelEl = Array.from(dialog.querySelectorAll('*'))
      .find(el => (el.textContent || '').trim() === '駒サイズ');
    if (labelEl) {
      const block = labelEl.closest('div,section') || labelEl.parentElement;
      const nums = Array.from(block?.querySelectorAll?.('input') || [])
        .filter(i => i.type === 'number' || /^[0-9-]+$/.test((i.value || '').trim()));
      if (nums[0]) return nums[0];

      const any = block?.querySelector?.('input');
      if (any) return any;
    }

    const num = dialog.querySelector('input[type="number"]');
    if (num) return num;

    return null;
  }

  function getPieceSize(dialog) {
    const inp = findSizeInput(dialog);
    const v = Number((inp?.value || '').trim());
    return Number.isFinite(v) ? v : null;
  }

  function getCurrentXY(dialog) {
    const ix = dialog.querySelector('input[name="x"]');
    const iy = dialog.querySelector('input[name="y"]');
    if (!ix || !iy) return null;

    const cx = Number((ix.value || '').trim());
    const cy = Number((iy.value || '').trim());
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return { x: cx, y: cy };
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

  async function runMove(parsed) {
    const { name } = parsed;

    const mv = findPieceMovableByName(name);
    if (!mv) {
      console.warn(LOG, '駒が見つかりません:', name);
      return false;
    }

    const r = mv.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    // 右クリック→「編集」
    const okMenu = await rightClickAndClickMenuItemAtPoint(cx, cy, '編集', 800);
    if (!okMenu) {
      console.warn(LOG, '右クリックメニューから「編集」を押せませんでした:', name);
      return false;
    }

    const dialog = await waitForDialog(2000);
    if (!dialog) {
      console.warn(LOG, '編集ダイアログが開きませんでした');
      return false;
    }

    // 誤爆対策：名前一致しないならキャンセル
    const openedName = getDialogName(dialog);
    const expectedName = normalizeName(name);
    if (!openedName) {
      console.warn(LOG, '編集ダイアログから名前を取得できませんでした。安全のためキャンセルします。', { expectedName });
      closeDialog(dialog);
      return false;
    }
    if (openedName !== expectedName) {
      console.warn(LOG, '別の駒を開いてしまいました。キャンセルします。', { expectedName, openedName });
      closeDialog(dialog);
      return false;
    }

    // 座標決定
    let x, y;

    if (parsed.mode === 'center') {
      const size = getPieceSize(dialog);
      if (size == null) {
        console.warn(LOG, '駒サイズを取得できませんでした。center移動をキャンセルします。');
        closeDialog(dialog);
        return false;
      }
      x = -(size * 12);
      y = -(size * 12);
    } else if (parsed.mode === 'xy') {
      // 相対/絶対混在
      const cur = getCurrentXY(dialog);
      if (!cur) {
        console.warn(LOG, '現在の x/y を取得できませんでした。相対指定がある可能性があるためキャンセルします。');
        closeDialog(dialog);
        return false;
      }

      x = (parsed.xSpec.kind === 'abs') ? parsed.xSpec.value : (cur.x + parsed.xSpec.value);
      y = (parsed.ySpec.kind === 'abs') ? parsed.ySpec.value : (cur.y + parsed.ySpec.value);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        console.warn(LOG, '計算後の x/y が不正。キャンセルします。', { x, y, cur, xSpec: parsed.xSpec, ySpec: parsed.ySpec });
        closeDialog(dialog);
        return false;
      }
    } else {
      console.error(LOG, 'invalid mode');
      closeDialog(dialog);
      return false;
    }

    const okXY = await setXYInDialog(dialog, x, y);
    if (!okXY) {
      console.warn(LOG, '編集ダイアログ内で x/y input が見つかりませんでした');
      closeDialog(dialog);
      return false;
    }

    return true;
  }

  function handleMove(fullText, sourceNode) {
    const parsed = parseMoveCommand(fullText);

    if (!parsed) {
      console.warn(LOG, 'コマンド解析に失敗:', fullText);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }
    if (parsed.mode === 'invalid') {
      console.error(LOG, '構文違反: .move <駒名> <x> <y>（x/yは数値 or ~数値）または .move <駒名>（駒名は1トークンのみ）', fullText);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }

    // 入力メッセージは .call 方式で自動削除（再発火・ログ汚染対策）
    if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);

    (async () => {
      try {
        const ok = await runMove(parsed);
        // 成否は必要ならログ出す（うるさいならコメントアウト）
        // console.log(LOG, 'move result:', ok);
      } catch (e) {
        console.error(LOG, 'move error:', e);
      }
    })();
  }

  // ============================================================
  // ===================== Chat監視 (.call踏襲) ===================
  // ============================================================

  const processedNodes = new WeakSet();

  function handleNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (processedNodes.has(node)) return;

    const text = node.innerText?.trim();
    if (!text) return;
    if (!text.startsWith(COMMAND_PREFIX)) return;

    processedNodes.add(node);
    handleMove(text, node);
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

    // 既存メッセージも一度走査
    chatRoot.querySelectorAll?.('li,div').forEach(handleNode);

    console.log(LOG, '監視開始（.move v2.0.0 core）');
    return true;
  }

  // 起動待ち（.execute v2.0.0 core と同じ）
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

  // 任意：コンソールから手動テストしたい時用
  window.__CCF_MOVE_CORE__ = {
    VERSION,
    handleMove, // 手動テスト用
    parseMoveCommand,
  };
})();
