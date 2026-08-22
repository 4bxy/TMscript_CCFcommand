/* CCF .vcall v1.1.0
 * - Tampermonkey から @require で読み込まれる GitHub core
 * - CCF .call v2.2.0 をベースに、ヴァイスシティフォーク（HTML版）の「魔神化」召喚に対応
 * - モンスターDBは .call と共通の GitHub JSON（monsterDBver1_0.json）を参照
 * - v1.1.0: HTML版（SW2.5_.c[all]_ヴァイスシティ）の buildCombatStatsMemo を移植。
 *   召喚時に memo へ 回避力／命中力／打撃点 の行を自動追加するように修正
 *   （剣の欠片・魔神化の反映後、部位ごとの params から生成）
 */

(function () {
  'use strict';

  // 二重ロード防止（@requireの再評価や手動実行の事故対策）
  if (window.__CCF_VCALL_CORE_V1_LOADED__) return;
  window.__CCF_VCALL_CORE_V1_LOADED__ = true;

  const VERSION = '1.1.0';
  const LOG = `[CCF .vcall v${VERSION}]`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  console.log(`🚀 ${LOG} loaded (GitHub core)`);

  // ============================================================
  // ======================== 設定値 ============================
  // ============================================================

  const COMMAND_PREFIX = '.vcall';
  const MAX_COUNT = 10;
  const MULTI_DELAY_MS = 500; // 1体ごとの貼り付け間隔
  const MAX_DEMONIZE_STAGE = 2;

  // === GitHub上のDB設定（.call と共通） ===
  const GITHUB_DB_URL = 'https://raw.githubusercontent.com/4bxy/SWmonsterDB/refs/heads/main/monsterDBver1_0.json';

  // localStorageのキー（.call とキャッシュを分離するため vcall 専用キーを使用）
  const DB_STORAGE_KEY = 'ccf_vcall_monsterDB_json';
  const DB_SCRIPT_VER_KEY = 'ccf_vcall_monsterDB_scriptVersion';

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
        console.warn(LOG, 'monsterDB が空です（GitHub取得も失敗）。.vcall は常に「該当魔物なし」になります。');
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
  // ====== 剣の欠片（-sN）処理ユーティリティ（.call と共通仕様） ===
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
  // ====== ヴァイスシティ: 魔神化（-mN）処理ユーティリティ =========
  //   HTML版フォーク（SW2.5_.c[all]_ヴァイスシティ）の
  //   applyDemonizeToRecord 系ロジックを移植
  //   ※固定値上昇表・魔神化能力表は「召喚（貼り付け）時に毎回抽選」
  // ============================================================

  // 固定値上昇表（d6）
  const DEMONIZE_FIXED_TABLE = {
    1: { hit: 1, weak: 3, ini: 2 },
    2: { hit: 1, resist: 2 },
    3: { hit: 2 },
    4: { hit: 1, atk: 3 },
    5: { hit: 1, eva: 1 },
    6: { hit: 1, def: 3 },
  };

  // 魔神化能力表（18種・等確率、重複しないようサンプリング）
  // effect2 がある項目はmemoに2行で記載する
  const DEMONIZE_ABILITIES = [
    { name: '腕が生える',   effect: '限定主動作1回増加' },
    { name: '狂気の肉体',   effect: '命中・回避・ダメージ+1' },
    { name: '強靭な皮膚',   effect: 'すべてのクリティカル無効' },
    { name: '生気の吸収',   effect: '攻撃の適用ダメージだけHP回復(1回)' },
    { name: '毒を宿す',     effect: '毒の体液',
      effect2: '[魔物レベル+1]（[魔物レベル+8]）／生命抵抗力／消滅' },
    { name: '這いずる触手', effect: '接触ダメージ適用後に追加で2点呪い魔法ダメージ' },
    { name: '羽根が生える', effect: '飛行' },
    { name: '武器を肥大化', effect: '同時攻撃' },
    { name: '魔神の影',     effect: '移動で転移' },
    { name: '魔神の再生',   effect: 'HP再生=「レベル」点、半分まで' },
    { name: '魔神の囁き',   effect: '主動作特殊能力達成値+2' },
    { name: '魂の吸収',     effect: '主動作でMP奪取 2d+[魔物レベル]点精神効果魔法ダメージ MP回復 起点指定1',
      effect2: '[魔物レベル+1]（[魔物レベル+8]）／精神抵抗力／半減' },
    { name: '炎の噴出',     effect: '炎のブレス 2d+[魔物レベル]点炎魔法ダメージ 射撃1',
      effect2: '[魔物レベル+2]（[魔物レベル+9]）／生命抵抗力／半減' },
    { name: '魔神の召喚',   effect: '3分だけ自身に従う魔神を召喚する(1回)' },
    { name: '魔神の領域',   effect: '補助動作1回、回避-2 MP5',
      effect2: '[魔物レベル+1]（[魔物レベル+8]）／精神抵抗力／消滅' },
    { name: '魔神の咆哮',   effect: '補助動作1回、必中同エリア味方命中+1・打撃点+2 MP5' },
    { name: '魔神の眼',     effect: '補助動作1回、宣言・補助動作封じ 射撃1、MP5',
      effect2: '[魔物レベル+1]（[魔物レベル+8]）／精神抵抗力／消滅' },
    { name: '魔神の指先',   effect: '補助動作1回、必中「レベル」点 起点指定1、MP(Lv/2)' },
  ];

  function rollD6() {
    return Math.floor(Math.random() * 6) + 1;
  }

  // HPラベル(HP1, HP2, ...)の数 = 部位数
  function countParts(status) {
    if (!Array.isArray(status)) return 0;
    return status.filter(s => s && typeof s.label === 'string' && /^HP\d+$/.test(s.label)).length;
  }

  // HP/MP全部位に +5×段階 を加算
  function applyDemonizeHpMpToRecord(rec, stage) {
    const data = rec && rec.data;
    if (!data || !Array.isArray(data.status) || stage <= 0) return;
    const bonus = stage * 5;
    data.status.forEach(st => {
      if (!st || typeof st.label !== 'string') return;
      if (!/^(HP|MP)\d+$/.test(st.label)) return;
      const v = parseInt(st.value, 10);
      const mx = parseInt(st.max, 10);
      if (Number.isFinite(v)) st.value = String(v + bonus);
      if (Number.isFinite(mx)) st.max = String(mx + bonus);
    });
  }

  // memoの「防護点:」行（／区切り・部位数分）に一律加算
  function applyDemonizeDefenseToMemo(data, delta) {
    if (typeof data.memo !== 'string') return;
    data.memo = data.memo.replace(/(防護点:)([^\n]+)/, (full, label, val) => {
      const nums = val.split('／').map(s => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? String(n + delta) : s;
      });
      return label + nums.join('／');
    });
  }

  // memoの「先制値:N」に加算
  function applyDemonizeInitiativeToMemo(data, delta) {
    if (typeof data.memo !== 'string') return;
    data.memo = data.memo.replace(/(先制値:)(-?\d+)/, (full, label, num) => {
      return label + (parseInt(num, 10) + delta);
    });
  }

  // memoの「魔物知識:X／Y(...)」のYに加算。「(なし)」など弱点値を持たない個体はスキップ
  function applyDemonizeWeaknessToMemo(data, delta) {
    if (typeof data.memo !== 'string') return;
    data.memo = data.memo.replace(/(魔物知識:\d+／)(\d+)/, (full, label, num) => {
      return label + (parseInt(num, 10) + delta);
    });
  }

  // 固定値上昇表を1回分適用（全部位に一律加算）
  function applyDemonizeFixedTableRoll(rec, roll, parts) {
    const data = rec && rec.data;
    const eff = DEMONIZE_FIXED_TABLE[roll];
    if (!data || !eff) return;

    function bumpPartParam(prefix, delta) {
      if (!Array.isArray(data.params)) return;
      for (let i = 1; i <= parts; i++) {
        const p = data.params.find(pp => pp && pp.label === `${prefix}${i}`);
        if (p) {
          const v = parseInt(p.value, 10);
          if (Number.isFinite(v)) p.value = String(v + delta);
        }
      }
    }

    if (eff.hit) bumpPartParam('命中力', eff.hit);
    if (eff.atk) bumpPartParam('打撃点', eff.atk);
    if (eff.eva) bumpPartParam('回避力', eff.eva);

    if (eff.resist && Array.isArray(data.params)) {
      ['生命抵抗力', '精神抵抗力'].forEach(label => {
        const p = data.params.find(pp => pp && pp.label === label);
        if (p) {
          const v = parseInt(p.value, 10);
          if (Number.isFinite(v)) p.value = String(v + eff.resist);
        }
      });
    }

    if (eff.def) applyDemonizeDefenseToMemo(data, eff.def);
    if (eff.ini) applyDemonizeInitiativeToMemo(data, eff.ini);
    if (eff.weak) applyDemonizeWeaknessToMemo(data, eff.weak);
  }

  // 魔神化能力表から段階数分、重複なしで等確率抽選
  function pickDemonizeAbilities(stage) {
    const pool = DEMONIZE_ABILITIES.slice();
    const picked = [];
    for (let i = 0; i < stage && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return picked;
  }

  // 抽選した魔神化能力をmemo末尾に追記（ステータスへの反映は行わない）
  function appendDemonizeAbilitiesToMemo(data, abilities) {
    if (!data || !abilities || abilities.length === 0) return;
    const lines = [];
    abilities.forEach(a => {
      lines.push(`★魔神化能力：${a.name}（${a.effect}）`);
      if (a.effect2) lines.push(a.effect2);
    });
    data.memo = (typeof data.memo === 'string' ? data.memo : '') + '\n' + lines.join('\n');
  }

  // memo先頭にラベル行を追加（重複防止）
  function addMemoLabelLine(data, label) {
    if (!data || typeof data.memo !== 'string') return;
    const lines = data.memo.split('\n');
    if (!lines.some(l => l.startsWith(label.slice(0, 5)))) {
      lines.unshift(label);
      data.memo = lines.join('\n');
    }
  }

  // 魔神化をレコードに適用（deep copy済みのrecordを渡すこと。剣の欠片適用後に実施すること）
  function applyDemonizeToRecord(rec, stage, parts, shardCount) {
    if (!rec || !rec.data || stage <= 0) return;

    applyDemonizeHpMpToRecord(rec, stage);
    for (let i = 0; i < stage; i++) {
      applyDemonizeFixedTableRoll(rec, rollD6(), parts);
    }
    // 抵抗力行・剣の欠片ラベルを最新のparamsで再描画（固定値上昇表のみで抵抗力が動く場合にも対応）
    updateMemoResistsFromParams(rec.data, shardCount);

    const abilities = pickDemonizeAbilities(stage);
    appendDemonizeAbilitiesToMemo(rec.data, abilities);

    const suffix = stage === 2 ? '◎◎' : '◎';
    addMemoLabelLine(rec.data, `★〈魔神化〉${suffix}`);
    if (!rec.data.name.endsWith(suffix)) {
      rec.data.name += suffix;
    }
  }

  // ============================================================
  // ====== コンバット統計行を memo に追加（HTML版 .c[all] から移植） ======
  //   - 生命抵抗力: 行の直後に 回避力: を挿入
  //   - 防護点: 行の直後に 命中力: / 打撃点: を挿入
  //   ※ 剣の欠片・魔神化 による params 更新の後に実施すること
  // ============================================================

  function getParam(params, label) {
    const p = params.find(p => p && p.label === label);
    return p ? p.value : '-';
  }

  function buildCombatStatsMemo(data, parts) {
    if (!parts || parts === 0) return data.memo;

    const params = data.params || [];
    const memo   = data.memo   || '';
    const lines  = memo.split('\n');
    const newLines = [];

    // 部位ごとの数値を収集（スラッシュ区切り）
    // パラメータが存在しない部位は '--' で表示
    function statVal(label) {
      const v = getParam(params, label);
      return (v === '-' || v === '' || v == null) ? '--' : v;
    }
    const evaVals = [], hitVals = [], atkVals = [];
    for (let i = 1; i <= parts; i++) {
      evaVals.push(statVal(`回避力${i}`));
      hitVals.push(statVal(`命中力${i}`));
      atkVals.push(statVal(`打撃点${i}`));
    }

    for (const line of lines) {
      newLines.push(line);
      if (line.startsWith('生命抵抗力:')) {
        newLines.push('回避力:' + evaVals.join('／'));
      } else if (line.startsWith('防護点:')) {
        newLines.push('命中力:' + hitVals.join('／'));
        newLines.push('打撃点:' + atkVals.join('／'));
      }
    }

    return newLines.join('\n');
  }

  // ============================================================
  // =================== .vcall のパース & 実行 ===================
  // ============================================================

  function clampCount(n) {
    if (!Number.isFinite(n)) return 1;
    n = Math.floor(n);
    if (n < 1) return 1;
    if (n > MAX_COUNT) return MAX_COUNT;
    return n;
  }

  function parseVCallCommand(fullText) {
    const m = fullText.match(/^\s*\.vcall\b(.*)$/);
    if (!m) return null;
    const rest = (m[1] || '').trim();
    if (!rest) return null;

    let tokens = rest.split(/\s+/);
    let initiative = null;
    let count = 1;
    let shardCount = 0;
    let demonizeStage = 0;

    // -sN（剣の欠片）・-mN（魔神化段階）オプションを抜き取って合算
    const tmp = [];
    for (const t of tokens) {
      const ms = t.match(/^-s(\d+)$/);
      if (ms) {
        const v = parseInt(ms[1], 10);
        if (Number.isFinite(v) && v > 0) {
          shardCount += v;
        }
        continue;
      }
      const mm = t.match(/^-m(\d+)$/);
      if (mm) {
        const v = parseInt(mm[1], 10);
        if (Number.isFinite(v) && v > 0) {
          demonizeStage += v;
        }
        continue;
      }
      tmp.push(t);
    }
    tokens = tmp;
    demonizeStage = Math.max(0, Math.min(MAX_DEMONIZE_STAGE, demonizeStage));

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

    return { name, initiative, count, shardCount, demonizeStage };
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

  async function runVCallSequence(baseRec, baseName, initiative, count, shardCount, demonizeStage) {
    for (let i = 0; i < count; i++) {
      const cloned = JSON.parse(JSON.stringify(baseRec));
      if (!cloned.data) cloned.data = {};

      // 名前：†と連番を付ける（魔神化の◎/◎◎はapplyDemonizeToRecord側で末尾に付与）
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

      // ヴァイスシティ: 魔神化強化（剣の欠片の後に実施。固定値上昇表・能力表はここで毎回抽選）
      if (demonizeStage > 0) {
        const parts = countParts(cloned.data.status);
        applyDemonizeToRecord(cloned, demonizeStage, parts, shardCount);
      }

      // コンバット統計行を memo に追加（回避力／防護点／命中力／打撃点）
      // ※ 剣の欠片・魔神化 による params 更新の後に実施すること（.call/HTML版と同じ順序）
      const finalParts = countParts(cloned.data.status);
      cloned.data.memo = buildCombatStatsMemo(cloned.data, finalParts);

      const jsonText = JSON.stringify(cloned);

      // v1 core は @grant none なので navigator.clipboard を使用
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
        'demonize=',
        demonizeStage,
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

  function handleVCall(fullText, sourceNode) {
    const parsed = parseVCallCommand(fullText);
    if (!parsed) {
      console.warn(LOG, 'コマンド解析に失敗:', fullText);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }

    const { name, initiative, count, shardCount, demonizeStage } = parsed;
    console.log(LOG, '解析結果 name=', name, 'initiative=', initiative, 'count=', count, 'shard=', shardCount, 'demonize=', demonizeStage);

    const baseRec = findMonsterByName(name);
    if (!baseRec) {
      console.warn(LOG, '該当魔物がDBに存在しません:', name);
      if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);
      return;
    }

    const baseName = baseRec?.data?.name || name;

    if (sourceNode) scheduleSelfDeletion(sourceNode, 1000);

    (async () => {
      await runVCallSequence(baseRec, baseName, initiative, count, shardCount, demonizeStage);
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
        handleVCall(text, node);
      } catch (e) {
        console.error(LOG, '.vcall 処理前の DB 初期化待機中にエラー:', e);
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

    console.log(LOG, `監視開始（.vcall v${VERSION} core）`);
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
  window.__CCF_VCALL_CORE__ = {
    VERSION,
    handleVCall,
    parseVCallCommand,
    buildCombatStatsMemo,
  };
})();
