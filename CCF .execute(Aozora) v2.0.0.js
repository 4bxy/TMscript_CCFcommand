/* CCF.execute v2.0.0
 * - TMから読み込む
 */

(function () {
  'use strict';

  // 二重ロード防止（@requireの再評価や手動実行の事故対策）
  if (window.__CCF_EXECUTE_CORE_V2_LOADED__) return;
  window.__CCF_EXECUTE_CORE_V2_LOADED__ = true;

  const VERSION = '2.0.0';
  const LOG = `[CCF .execute v${VERSION}]`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  console.log(`🚀 ${LOG} loaded (GitHub core)`);

  // ============================================================
  // ========== 設定（運用で触る場所はここだけ想定） ============
  // ============================================================

  // .execute メッセージ自動削除の開始タイミング（あなたの現運用：100ms）
  const EXECUTE_SELF_DELETE_AFTER_MS = 100;

  // 自動待機のデフォルト
  const DEFAULT_WAIT_MS = 200;

  // コマンド別 自動待機
  // 行の「先頭トークン」で判定（例: ".move" / ".call"）
  const WAIT_BY_PREFIX_MS = {
    '.move': 700,
    '.call': 1000,
    // 必要になったら増やす
    // '.Ccheck': 600,
    // '.atkSeq': 400,
  };

  // ============================================================
  // ====================== React対応の確実送信 ==================
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

  function postMessage(message) {
    const inputBox = document.querySelector('textarea[placeholder="メッセージを入力"]');
    if (!inputBox) return;

    simulateInput(inputBox, message);

    // 長時間待機後でも安定するようフォーカスをリセット
    inputBox.blur();
    setTimeout(() => {
      inputBox.focus();
      inputBox.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

      setTimeout(() => {
        const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 });
        const press = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 });
        const up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 });

        inputBox.dispatchEvent(down);
        inputBox.dispatchEvent(press);
        setTimeout(() => inputBox.dispatchEvent(up), 30);
      }, 50);
    }, 30);
  }

  // ============================================================
  // ========= 自動削除（編集→空→保存）ユーティリティ ============
  // ============================================================

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

  const selfDeleteScheduled = new WeakMap(); // node -> timeoutId
  const selfDeleteFinished = new WeakSet();  // node processed

  function scheduleSelfDeletion(node, afterMs) {
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
    // console.log(LOG, `self-delete を ${afterMs}ms 後にスケジュール`);
  }

  // ============================================================
  // ======================= .execute 本体 ========================
  // ============================================================

  function isExecuteHeader(line) {
    return /^\s*\.execute\b/i.test(line || '');
  }

  function isTimeLine(line) {
    return /^\s*\*time\s+\d+/i.test(line || '');
  }

  function parseTimeMs(line) {
    const m = (line || '').match(/^\s*\*time\s+(\d+)/i);
    return m ? (parseInt(m[1], 10) || 0) : 0;
  }

  function parseVarPayload(line) {
    const m = (line || '').match(/^\s*\*var\s+(.+)/i);
    return m ? m[1] : null;
  }

  function getPrefixKey(line) {
    const s = (line || '').trim();
    if (!s) return '';
    return s.split(/\s+/)[0] || '';
  }

  function getAutoWaitMsForLine(line) {
    const key = getPrefixKey(line);
    if (!key) return DEFAULT_WAIT_MS;
    return (WAIT_BY_PREFIX_MS[key] != null) ? WAIT_BY_PREFIX_MS[key] : DEFAULT_WAIT_MS;
  }

  function handleExecute(fullText, sourceNode) {
    // 空行は落とす（見た目の運用性優先）
    const rawLines = (fullText || '').split('\n').map(l => l.replace(/\r/g, ''));
    const lines = rawLines.map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    if (!isExecuteHeader(lines[0])) return;

    // 再発火防止：常時 自動削除（あなたの現運用：100ms）
    if (sourceNode) scheduleSelfDeletion(sourceNode, EXECUTE_SELF_DELETE_AFTER_MS);

    const execLines = lines.slice(1);
    if (!execLines.length) return;

    let delay = 0;

    for (let i = 0; i < execLines.length; i++) {
      const line = execLines[i];
      const nextLine = (i + 1 < execLines.length) ? execLines[i + 1] : null;
      const isLast = (i === execLines.length - 1);

      // *time N : 待機のみ積む（送信なし）※この行には自動待機は付かない
      if (isTimeLine(line)) {
        delay += parseTimeMs(line);
        continue;
      }

      // *var XXX : {XXX} を送信
      const varPayload = parseVarPayload(line);
      if (varPayload != null) {
        const payload = `{${varPayload}}`;
        setTimeout(() => {
          // console.log(LOG, '📦 実行(*var):', payload);
          postMessage(payload);
        }, delay);
      } else {
        // 通常行：そのまま送信
        setTimeout(() => {
          // console.log(LOG, '📦 実行:', line);
          postMessage(line);
        }, delay);
      }

      // 自動待機の挿入：
      // - 最終行の後は待たない
      // - 次行が *time なら、明示*timeが「次の実行まで待つ」なので自動待機は入れない
      if (!isLast) {
        if (nextLine && isTimeLine(nextLine)) {
          // 自動待機なし
        } else {
          delay += getAutoWaitMsForLine(line);
        }
      }
    }
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
    if (!/^\s*\.execute\b/i.test(text)) return;

    processedNodes.add(node);
    handleExecute(text, node);
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

    console.log(LOG, '監視開始（.execute v2.0.0 core）');
    return true;
  }

  // 起動待ち
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

  // 任意：コンソールから手動実行したい時用
  window.__CCF_EXECUTE_CORE__ = {
    VERSION,
    handleExecute, // 手動テスト用
  };
})();
