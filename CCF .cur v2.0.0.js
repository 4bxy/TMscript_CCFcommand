/* CCFOLIA .cur core v2.0.0 */
(function () {
  'use strict';

  const VERSION = '2.0.0';
  const LOG_PREFIX = '[CCF .cur]';

  // 二重ロード防止
  if (window.__CCF_CUR_CORE_V2_LOADED__) {
    console.log(`${LOG_PREFIX} v${VERSION}（core）は既にロード済みです↩️`);
    return;
  }
  window.__CCF_CUR_CORE_V2_LOADED__ = true;

  console.log(`${LOG_PREFIX} v${VERSION}（core）をロードしました📦`);

  const STORAGE_KEY = '__CCF_CUR_V2_PROCESSED__';

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

  // ===== 旧v0.2.3のデータ =====
  const depthPoints = [
    50, 75, 100,
    ...Array.from({ length: 10 }, (_, i) => 110 + i * 10), // 110 ～ 200 含む
    ...Array.from({ length: 60 }, (_, i) => 205 + i * 5)   // 205 ～ 495
  ];

  const debuffTableA = [
    [1, 30, "なし"],
    [31, 40, "器用能力値-1"],
    [41, 50, "敏捷能力値-1"],
    [51, 60, "筋力能力値-1"],
    [61, 70, "生命能力値-1"],
    [71, 80, "知力能力値-1"],
    [81, 90, "精神能力値-1"],
    [91, 100, "購入基本値+1"]
  ];

  const debuffTableB = [
    [1, 10, "なし"],
    [11, 20, "器用能力値-1"],
    [21, 30, "敏捷能力値-1"],
    [31, 40, "筋力能力値-1"],
    [41, 50, "生命能力値-1"],
    [51, 60, "知力能力値-1"],
    [61, 70, "精神能力値-1"],
    [71, 74, "購入基本値+1"],
    [75, 79, "【幻覚】レベル+1"],
    [80, 84, "【幻聴】レベル+1"],
    [85, 89, "【幻嗅】レベル+1"],
    [90, 94, "【幻味】レベル+1"],
    [95, 99, "【幻触】レベル+1"],
    [100, 100, "ロスト"]
  ];

  const debuffTableC = [
    [1, 5, "器用能力値-1"],
    [6, 10, "敏捷能力値-1"],
    [11, 15, "筋力能力値-1"],
    [16, 20, "生命能力値-1"],
    [21, 25, "知力能力値-1"],
    [26, 30, "精神能力値-1"],
    [31, 43, "【幻覚】レベル+1"],
    [44, 56, "【幻聴】レベル+1"],
    [57, 69, "【幻嗅】レベル+1"],
    [70, 82, "【幻味】レベル+1"],
    [83, 95, "【幻触】レベル+1"],
    [96, 100, "ロスト"]
  ];

  const outputOrder = [
    "器用能力値-1",
    "敏捷能力値-1",
    "筋力能力値-1",
    "生命能力値-1",
    "知力能力値-1",
    "精神能力値-1",
    "【幻覚】レベル+1",
    "【幻聴】レベル+1",
    "【幻嗅】レベル+1",
    "【幻味】レベル+1",
    "【幻触】レベル+1",
    "ロスト"
  ];

  function findDebuff(roll, table) {
    for (const [start, end, effect] of table) {
      if (roll >= start && roll <= end) return effect;
    }
    return "不明なデバフ";
  }

  function getTable(depth) {
    if (depth <= 75) return debuffTableA;
    if (depth < 200) return debuffTableB;
    if (depth <= 495) return debuffTableC;
    return null;
  }

  // ===== 入力・送信 =====
  function simulateInput(el, value) {
    if (!el) return;
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

  // /add と同じ「今日 HH:MM」一致のみ処理
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

  // ===== 解析 =====
  // .cur [現在, 上昇後]
  const CUR_REGEX = /\.cur\s*\[\s*(\d+)\s*,\s*(\d+)\s*]/i;

  function handleCurseCommand(text) {
    const match = String(text).match(CUR_REGEX);
    if (!match) return;

    const prev = parseInt(match[1], 10);
    const next = parseInt(match[2], 10);

    if (!Number.isFinite(prev) || !Number.isFinite(next)) return;

    if (next <= prev) {
      postMessage("⚠️ 呪深度が上昇していません。");
      return;
    }

    const affectedDepths = depthPoints.filter(p => p > prev && p <= next);
    if (affectedDepths.length === 0) {
      postMessage("🌀 呪深度到達ポイントはありません。");
      return;
    }

    const resultMap = Object.create(null);
    for (const depth of affectedDepths) {
      const table = getTable(depth);
      if (!table) continue;

      const roll = Math.floor(Math.random() * 100) + 1;
      const debuff = findDebuff(roll, table);

      // 旧仕様：なし/購入基本値+1 は集計しない
      if (debuff === "なし" || debuff === "購入基本値+1") continue;

      resultMap[debuff] = (resultMap[debuff] || 0) + 1;
    }

    const totalRolls = affectedDepths.length;
    const resultLines = [`◆ロール回数：${totalRolls}回◆`];

    outputOrder.forEach(effect => {
      if (resultMap[effect]) resultLines.push(`${effect}　${resultMap[effect]}回`);
    });

    postMessage(resultLines.join("\n"));
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
          if (fullText.startsWith('◆ロール回数：')) continue;
          if (fullText.startsWith('⚠️') || fullText.startsWith('🌀')) continue;

          // .cur が無いなら無視
          if (!fullText.toLowerCase().includes('.cur')) continue;

          // 時刻フィルタ（過去ログ暴発を切る主軸）
          if (!shouldProcessByTime(item)) continue;

          // 同一分リロード対策：sessionStorage 指紋
          const fp = makeFingerprint(item, fullText);
          if (processed.has(fp)) continue;

          processed.add(fp);
          saveProcessedToSession();

          console.log(`${LOG_PREFIX} v${VERSION} .cur検知→処理します📦`, {
            charName: extractCharNameFromItem(item),
            time: getTimeLabelFromItem(item),
          });

          handleCurseCommand(item.innerText || '');
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
