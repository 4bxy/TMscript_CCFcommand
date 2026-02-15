/* CCFOLIA /add core v2.0.0 */
(function () {
  'use strict';

  const VERSION = '2.0.0';
  const LOG_PREFIX = '[CCF /add]';

  // 二重ロード防止
  if (window.__CCF_ADD_CORE_V2_LOADED__) {
    console.log(`${LOG_PREFIX} v${VERSION}（core）は既にロード済みです↩️`);
    return;
  }
  window.__CCF_ADD_CORE_V2_LOADED__ = true;

  console.log(`${LOG_PREFIX} v${VERSION}（core）をロードしました📦`);

  const STORAGE_KEY = '__CCF_ADD_V2_PROCESSED__';

  // ===== 無限ループ/連投対策 =====
  let isPosting = false;
  let lastPostAt = 0;

  // ===== 処理済み（リロード跨ぎ） =====
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

  // ===== 入力・送信 =====
  function simulateInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function postMessage(message) {
    const inputBox = document.querySelector('textarea[placeholder="メッセージを入力"]');
    if (!inputBox) {
      console.warn(`${LOG_PREFIX} v${VERSION} 入力欄が見つかりませんでした⚠️`);
      return;
    }

    const now = Date.now();
    if (isPosting) return;
    if (now - lastPostAt < 700) return; // 0.7秒以内の連投抑止

    isPosting = true;
    lastPostAt = now;

    simulateInput(inputBox, message + ' ');

    setTimeout(() => {
      inputBox.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 })
      );
      inputBox.dispatchEvent(
        new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 })
      );

      // 必ず解除（無限ループ防止の要）
      setTimeout(() => {
        isPosting = false;
      }, 300);
    }, 120);
  }

  // ===== 解析 =====
  function extractDamageStats(text) {
    const lines = String(text).split('\n');
    let total = 0;
    let hit = 0;

    for (const line of lines) {
      if (line.includes('自動的失敗')) continue;
      const match = line.match(/＞\s*(\d+)\s*$/);
      if (match) {
        total += parseInt(match[1], 10);
        hit += 1;
      }
    }
    return { total, hit };
  }

  // ===== “投稿1件”を確実に掴む =====
  function getMessageItemElement(fromNode) {
    if (!(fromNode instanceof HTMLElement)) return null;

    const closest = fromNode.closest?.('[class*="MuiListItem-root"]');
    if (closest) return closest;

    const inner = fromNode.querySelector?.('[class*="MuiListItem-root"]');
    return inner || null;
  }

  function normalizeSpaces(s) {
    return String(s)
      .replace(/\u00a0/g, ' ') // NBSP -> space
      .replace(/\s+/g, ' ') // collapse
      .trim();
  }

  function extractCharNameFromItem(item) {
    const h6 = item.querySelector('h6.MuiTypography-root');
    if (!h6) return '（不明なキャラ）';

    const caption = h6.querySelector('span.MuiTypography-caption');
    const full = normalizeSpaces(h6.innerText || '');
    const cap = normalizeSpaces(caption?.innerText || '');

    const name = cap ? normalizeSpaces(full.replace(cap, '').replace(/-$/, '')) : full;
    return name || '（不明なキャラ）';
  }

  function getTimeLabelFromItem(item) {
    const h6 = item.querySelector('h6.MuiTypography-root');
    const cap = h6?.querySelector('span.MuiTypography-caption');
    if (!cap) return null;

    let t = normalizeSpaces(cap.innerText || '');
    t = t.replace(/^[\s-]+/, '').trim(); // 先頭の "-" や空白を落とす
    return t || null;
  }

  function getNowHHMM() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

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

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h >>>= 0;
    }
    return `h${h.toString(16)}`;
  }

  // ===== 監視 =====
  function observeChat() {
    const chatRoot = document.querySelector('[class*="MuiList-root"]');
    if (!chatRoot) return false;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          const item = getMessageItemElement(added);
          if (!item) continue;

          const fullText = normalizeSpaces(item.innerText || '');
          if (!fullText) continue;

          // 自分の出力は拾わない（無限ループ保険）
          if (fullText.startsWith('【dmg】')) continue;

          // /add が無いなら無視
          if (!fullText.toLowerCase().includes('/add')) continue;

          // 時刻フィルタ（過去ログ暴発を切る主軸）
          if (!shouldProcessByTime(item)) continue;

          // 同一分リロード対策：sessionStorage 指紋
          const fp = makeFingerprint(item, fullText);
          if (processed.has(fp)) continue;

          processed.add(fp);
          saveProcessedToSession();

          const { total, hit } = extractDamageStats(item.innerText || '');
          const charName = extractCharNameFromItem(item);

          const output =
            `【dmg】${charName}\n` +
            `【dmg】：${total}\n` +
            `【hit】：${hit}`;

          console.log(`${LOG_PREFIX} v${VERSION} /add検知→出力します📦`, {
            charName,
            total,
            hit,
            time: getTimeLabelFromItem(item),
          });

          postMessage(output);
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
})();
