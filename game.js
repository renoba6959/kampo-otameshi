/*
 * 漢方カードバトル — ゲームロジック（薬瓶・積み上げ方式）
 * =========================================================
 * 設計メモ：「薬瓶・積み上げ方式 設計メモ.md」
 *
 * ■ 3階層：ゲーム ＞ ラウンド（お題1枚）＞ ターン（「ターンを終える」で進む手番）
 * ■ 手札の生薬／棚の薬瓶を「調合エリア」に入れて方剤を組む
 *    - 一致した方剤は「薬瓶に確保」して棚に残せる（お題をまたいで再利用可）
 *    - お題に合う方剤ができたら「提出」＝患者に渡す（消費）
 * ■ 得点＝症状マッチ度(0〜3) ＋ 早解きボーナス（マッチ0なら早解き無効）
 */
(function () {
  "use strict";

  const { herbs, formulas, symptoms, themes } = window.KAMPO;

  // ---- 設定 -------------------------------------------------------
  const CONFIG = {
    maxRounds: 10,      // 1ゲームのお題数の上限（実際は選んだテーマの方剤数で決まる）
    handStart: 6,       // 各ラウンド開始時に最低確保する手札
    handSoft: 10,       // ターン終了時はここまで減らす（やわらかい上限）
    handHard: 12,       // 1手番で一時的に持てる上限（引くのはここまで）
    drawPerTurn: 2,     // ドロー1回で増える枚数（ドローは1手番に1回）
    deckCopies: 3,      // 各生薬をデッキに何枚入れるか（デフォルト）
    earlyBonus: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1, 6: 1 }, // 手番別の早解きボーナス（7手目以降0）
    // 構成生薬数（味数）に応じた薬味数ボーナス。大きい味数から順に判定（調整可）
    sizeBonus: [{ min: 9, add: 3 }, { min: 6, add: 2 }, { min: 1, add: 0 }],
    harvestPick: 5,     // 「収穫カード」で山札から指名できる生薬の最大数（調整可）
    harvestCardCopies: 3, // デッキに入れる「収穫カード」の既定枚数（デッキ編集の初期値）
    bigHarvestCardCopies: 2, // デッキに入れる「大収穫カード」の既定枚数（デッキ編集の初期値）
    jamaCardCopies: 1,       // 対戦：デッキに入れる「お邪魔カード（招かれざる客）」の既定枚数
    turnDrawDelayMs: 1200,   // 手番開始の自動ドロー(+2)を、配り/切替の少しあとに出す間（ms）
    deckCardMax: 3,     // デッキ編集で補助カードを入れられる上限（各種類）
    herbMax: 9,         // デッキ編集で生薬を入れられる上限（各種類。0にすると外せる）
    editionLabel: "",   // 版の表示ラベル（例：お試し版）。空なら非表示。KAMPO_CONFIGで上書き
    requireConsent: false, // 起動時に免責への同意ゲートを出す（公開版=true）。KAMPO_CONFIGで上書き
  };
  // 外部から一部設定を上書きできる口（お試し版などで使用。未定義なら既定のまま）
  //   例：window.KAMPO_CONFIG = { harvestCardCopies: 1, bigHarvestCardCopies: 1 }
  if (window.KAMPO_CONFIG) Object.assign(CONFIG, window.KAMPO_CONFIG);

  // 補助（アクション）カードの定義。生薬idと区別するため id は "act:" で始める
  const ACTIONS = {
    "act:harvest": {
      name: "収穫", kana: "しゅうかく",
      copy: "山札から生薬を指名して手札に加える",
    },
    "act:daishukaku": {
      name: "大収穫", kana: "だいしゅうかく",
      copy: "捨て札をすべて山札に戻してシャッフル",
    },
    "act:jama": {
      name: "招かれざる客", kana: "まねかれざるきゃく",
      copy: "相手の薬瓶を1つ壊す",
    },
  };
  const isAction = (id) => typeof id === "string" && id.startsWith("act:");

  // デッキ編集で選んだ枚数（スタート画面で調整）。herbs は { 生薬id: 枚数 }
  let deckPrefs = { harvest: CONFIG.harvestCardCopies, daishukaku: CONFIG.bigHarvestCardCopies, herbs: {} };
  // スタート画面で選んだモード： "solo"（1人）／ "vs"（同じ端末で2人交代）
  let selectedMode = "solo";
  // 選択中のテーマ（モード切替で再描画しても保持する）
  let selectedThemes = ["kaze"];

  // ---- 便利関数 ---------------------------------------------------
  const herbById = Object.fromEntries(herbs.map(h => [h.id, h]));
  // 生薬の並び順：寒熱（温→平→寒）でまとめ、各グループ内はあいうえお順（かな）。
  // 手札は入手順のまま。収穫・捨て札確認・デッキ編集はこの順に統一する。
  const netsuRank = { "温": 0, "平": 1, "寒": 2 };
  const byHerbOrder = (a, b) => {
    const ha = herbById[a], hb = herbById[b];
    const ra = netsuRank[ha.netsu] ?? 9, rb = netsuRank[hb.netsu] ?? 9;
    if (ra !== rb) return ra - rb;
    return ha.kana.localeCompare(hb.kana, "ja");
  };
  const formulaById = Object.fromEntries(formulas.map(f => [f.id, f]));
  const symptomById = Object.fromEntries(symptoms.map(s => [s.id, s]));
  // 構成生薬の集合を正規化した文字列キー（順不同・重複なしの厳密一致用）
  const keyOf = (ids) => Array.from(new Set(ids)).sort().join(",");
  const uniq = (ids) => Array.from(new Set(ids));
  const formulaByHerbKey = Object.fromEntries(formulas.map(f => [keyOf(f.herbs), f]));

  const netsuClass = { "温": "netsu-warm", "寒": "netsu-cold", "平": "netsu-neutral" };
  const matchLabel = { 3: "完全一致", 2: "概ねOK", 1: "部分一致", 0: "証に不適合" };

  // 症状カードが「正解」とする方剤（score が最大＝3点の方剤）のid
  const primaryFormulaId = (sym) =>
    Object.entries(sym.score).sort((a, b) => b[1] - a[1])[0][0];

  // 選んだテーマ集合から、使う方剤・症状・生薬を導く
  function themeSelection(themeIds) {
    const set = new Set(themeIds);
    const activeFormulas = formulas.filter(f => set.has(f.theme));
    const activeFormulaIds = new Set(activeFormulas.map(f => f.id));
    // 症状は「正解の方剤」がテーマに含まれるものだけ
    const activeSymptoms = symptoms.filter(s => activeFormulaIds.has(primaryFormulaId(s)));
    // デッキに入れる生薬＝テーマの方剤に必要な生薬の和集合
    const herbSet = new Set();
    activeFormulas.forEach(f => f.herbs.forEach(id => herbSet.add(id)));
    return { activeFormulas, activeSymptoms, herbIds: [...herbSet].sort(byHerbOrder) };
  }

  // デッキ構成（与えた生薬idの一覧から各 deckCopies 枚を積む）
  // window.KAMPO_DECK = { herbId: 枚数, ... } を定義すればその枚数を優先する。
  function buildDeck(herbIds, prefs) {
    prefs = prefs || deckPrefs;             // 対戦は各プレイヤーの編集内容を渡す
    const recipe = window.KAMPO_DECK || null;
    const deck = [];
    for (const id of herbIds) {
      const n = recipe && Number.isFinite(recipe[id]) ? recipe[id]
        : Number.isFinite(prefs.herbs[id]) ? prefs.herbs[id]
        : CONFIG.deckCopies;
      for (let i = 0; i < n; i++) deck.push(id);
    }
    // 補助カードの枚数：テストフック(KAMPO_ACTIONS) ＞ プレイヤーのデッキ編集(prefs) ＞ 既定(CONFIG)
    const actConf = window.KAMPO_ACTIONS || null;
    const actionCount = (key, def) =>
      (actConf && Number.isFinite(actConf[key])) ? actConf[key]
      : (prefs && Number.isFinite(prefs[key])) ? prefs[key]
      : def;
    const harvestN = actionCount("harvest", CONFIG.harvestCardCopies);
    for (let i = 0; i < harvestN; i++) deck.push("act:harvest");
    const bigN = actionCount("daishukaku", CONFIG.bigHarvestCardCopies);
    for (let i = 0; i < bigN; i++) deck.push("act:daishukaku");
    // お邪魔カードは対戦専用（prefs.jama を指定したときだけ入る。ソロは未指定＝0）
    const jamaN = actionCount("jama", 0);
    for (let i = 0; i < jamaN; i++) deck.push("act:jama");
    return deck;
  }

  // 山札から指定idの生薬を1枚だけ取り除く（見つかれば true）
  function removeFromDeck(id) {
    const i = state.deck.indexOf(id);
    if (i < 0) return false;
    state.deck.splice(i, 1);
    return true;
  }

  // 疑似乱数シャッフル
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- ゲーム状態 -------------------------------------------------
  let state;

  // 対戦のセットアップ結果： [{name, prefs}, {name, prefs}]（各プレイヤーの名前と編集済みデッキ）
  function newGame(themeIds, mode, vsSetup) {
    const sel = themeSelection(themeIds);
    const isVs = mode === "vs";
    state = {
      mode: isVs ? "vs" : "solo",           // "solo"=1人 ／ "vs"=同じ端末で2人交代
      themeIds: themeIds.slice(),           // 今回選ばれたテーマ
      // --- 共有：お題まわり ---
      symptomPile: shuffle(sel.activeSymptoms.map(s => s.id)),
      totalRounds: Math.min(sel.activeSymptoms.length, CONFIG.maxRounds),
      round: 0,            // 何ラウンド目か（1始まり表示・共有）
      currentSymptom: null,
      hintOpen: false,
      finished: false,
      nextUid: 1,          // uidは全体で一意（盤をまたいでも衝突しない）
      // --- アクティブ盤（ソロ＝唯一の盤／対戦＝手番プレイヤーの盤）---
      deck: [], discard: [], hand: [], shelf: [],
      pot: { hand: [], bottles: [] },
      roundTurn: 1, drewThisTurn: false, score: 0, log: [],
      justDrawn: [], usedActions: [], roundOf: 0,
      // --- 対戦メタ ---
      active: 0,
      players: null,       // 対戦：[盤スナップショット0, 盤スナップショット1]
      playerNames: isVs
        ? [(vsSetup && vsSetup[0].name) || "プレイヤー1", (vsSetup && vsSetup[1].name) || "プレイヤー2"]
        : null,
    };
    if (isVs) {
      // 各自の編集デッキで盤を作る（vsSetup が無ければ既定 deckPrefs）
      const prefs0 = vsSetup ? vsSetup[0].prefs : null;
      const prefs1 = vsSetup ? vsSetup[1].prefs : null;
      state.players = [makeBoard(sel, prefs0), makeBoard(sel, prefs1)];
      nextRound();     // round=1・お題セット（対戦はここでは引かない）
      beginTurn(0);    // 先手＝プレイヤー1が初手を引く
    } else {
      state.deck = shuffle(buildDeck(sel.herbIds));
      nextRound();     // round=1・お題セット・手札を初手6枚まで補充
    }
    render();
  }

  // ---- 対戦：盤（プレイヤーの持ち物）を入れ替える仕組み ----------------
  // アクティブ盤は state の下記フィールドに入る。手番交代で退避／復元する。
  const BOARD_FIELDS = ["deck", "discard", "hand", "shelf", "roundTurn", "drewThisTurn", "score", "log", "usedActions", "roundOf"];
  function makeBoard(sel, prefs) {
    return {
      deck: shuffle(buildDeck(sel.herbIds, prefs)),
      discard: [], hand: [], shelf: [],
      roundTurn: 1, drewThisTurn: false, score: 0, log: [], usedActions: [], roundOf: 0,
    };
  }
  function saveBoard(i) { const b = state.players[i]; for (const f of BOARD_FIELDS) b[f] = state[f]; }
  function loadBoard(i) {
    const b = state.players[i];
    for (const f of BOARD_FIELDS) state[f] = b[f];
    state.pot = { hand: [], bottles: [] };
    state.justDrawn = [];
    state.hintOpen = false;
    state.active = i;
  }
  // プレイヤー i の手番を始める。初手番は開幕の手札を配り、2回目以降は自動で+2枚ドロー。
  function beginTurn(i) {
    loadBoard(i);
    if (state.roundOf !== state.round) { // このお題に初めて着手＝初手番。まず開幕を配る
      state.roundOf = state.round;
      state.roundTurn = 1;
      state.justDrawn = drawTo(Math.max(state.hand.length, CONFIG.handStart));
    }
    state.drewThisTurn = true;
    scheduleStartDraw(); // 少し間を置いて手番開始の+2（決定論モードは即時）
    // お邪魔カードで薬瓶を壊されていたら、手番開始時に「割れる演出」で知らせる（render後に表示）
    if (state.players[i].notice && state.players[i].notice.length) {
      const names = state.players[i].notice;
      state.players[i].notice = null;
      setTimeout(() => showBottleBrokenNotice(names), 80);
    }
  }

  // 薬瓶が破壊されたお知らせ（瓶が割れるアニメつき）
  function showBottleBrokenNotice(names) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="broken-modal">
        <div class="broken-anim"><span class="broken-bottle">🫙</span><span class="broken-burst">💥</span></div>
        <div class="broken-title">🐭 招かれざる客！</div>
        <p class="broken-text">あなたの薬瓶「${names.join("」「")}」が<b>破壊</b>され、<br>中の生薬は<b>あなたの捨て札</b>に移りました。<br><span class="broken-sub">（「大収穫」で山札に戻して立て直せます）</span></p>
        <button id="broken-ok" class="primary-btn">確認</button>
      </div>`;
    $("#app").appendChild(overlay);
    document.getElementById("broken-ok").addEventListener("click", () => overlay.remove());
  }
  // 手番開始の自動ドロー(+2)を「少し間を置いて」実行する（配り/切替のあと引く感じを出す）。
  // 決定論モード（KAMPO_DECK/KAMPO_ACTIONS指定時）は遅延なしで即引く（テスト用）。
  let drawTimer = null;
  function scheduleStartDraw() {
    if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
    const doDraw = () => {
      drawTimer = null;
      if (!state || state.finished || !state.currentSymptom) return;
      state.justDrawn = drawTo(Math.min(CONFIG.handHard, state.hand.length + CONFIG.drawPerTurn));
      render();
    };
    const delay = (window.KAMPO_DECK || window.KAMPO_ACTIONS) ? 0 : (CONFIG.turnDrawDelayMs || 0);
    if (delay > 0) drawTimer = setTimeout(doDraw, delay);
    else doDraw();
  }

  // 現在の盤を退避して、目隠し画面を挟み、next の手番を始める
  function handoffTo(next) {
    saveBoard(state.active);
    showHandoff(next);
  }
  // 対戦の現在得点・薬瓶数・手札数（アクティブは live、相手は保存済みの盤から）
  const scoreOf = (i) => (i === state.active ? state.score : (state.players ? state.players[i].score : 0));
  const shelfCountOf = (i) => (i === state.active ? state.shelf.length : state.players[i].shelf.length);
  const handCountOf = (i) => (i === state.active ? state.hand.length : state.players[i].hand.length);

  // ---- スタート画面（テーマ選択）---------------------------------
  function getCheckedThemes() {
    return Array.from(document.querySelectorAll(".theme-check:checked"))
      .map(el => el.value);
  }

  // 「おまかせ（最低保証）」：選んだテーマのお題を全部クリアできる各生薬の最低枚数
  //   ＝ min（そのテーマでその生薬を含む“出題方剤”の数, そのゲームのお題数）
  function guaranteeCounts(ids) {
    const sel = themeSelection(ids);
    const rounds = Math.min(sel.activeSymptoms.length, CONFIG.maxRounds);
    const counts = {};
    sel.herbIds.forEach(id => counts[id] = 0);
    sel.activeSymptoms.forEach(s => {
      const f = formulaById[primaryFormulaId(s)];
      if (f) f.herbs.forEach(id => { if (counts[id] != null) counts[id] += 1; });
    });
    Object.keys(counts).forEach(id => counts[id] = Math.min(counts[id], rounds));
    return counts;
  }

  const herbCountOf = (id) => Number.isFinite(deckPrefs.herbs[id]) ? deckPrefs.herbs[id] : CONFIG.deckCopies;

  // デッキ合計枚数の表示を更新
  function updateDeckTotal() {
    const el = document.querySelector("#deck-total");
    if (!el) return;
    const ids = selectedThemes;
    if (ids.length === 0) { el.textContent = ""; return; }
    const sel = themeSelection(ids);
    const herbTotal = sel.herbIds.reduce((sum, id) => sum + herbCountOf(id), 0);
    const aux = deckPrefs.harvest + deckPrefs.daishukaku + (deckPrefs.jama || 0);
    el.textContent = `デッキ合計 ${herbTotal + aux} 枚（生薬 ${herbTotal} ＋ 補助・お邪魔 ${aux}）`;
  }

  // デッキ編集UIのHTML（スタート画面・対戦の準備画面で共用）。showJama=trueで対戦専用のお邪魔カードも編集可
  function deckEditorHTML(showJama) {
    return `
        <div class="deck-editor">
          <div class="deck-editor-title">デッキ編集</div>

          <div class="de-section-title">補助カード</div>
          <div class="deck-editor-row">
            <span class="de-name"><span class="de-titleline">🟡 収穫カード<span class="de-max">（最大${CONFIG.deckCardMax}枚）</span></span><span class="de-desc">山札から生薬を最大${CONFIG.harvestPick}枚 指名して手札へ</span></span>
            <span class="de-stepper">
              <button type="button" class="de-step" data-card="harvest" data-delta="-1">−</button>
              <b id="de-harvest">${deckPrefs.harvest}</b>
              <button type="button" class="de-step" data-card="harvest" data-delta="1">＋</button>
            </span>
          </div>
          <div class="deck-editor-row">
            <span class="de-name"><span class="de-titleline">🟢 大収穫カード<span class="de-max">（最大${CONFIG.deckCardMax}枚）</span></span><span class="de-desc">捨て札を全部 山札へ戻す</span></span>
            <span class="de-stepper">
              <button type="button" class="de-step" data-card="daishukaku" data-delta="-1">−</button>
              <b id="de-daishukaku">${deckPrefs.daishukaku}</b>
              <button type="button" class="de-step" data-card="daishukaku" data-delta="1">＋</button>
            </span>
          </div>
          ${showJama ? `
          <div class="de-section-title">お邪魔カード（対戦専用）</div>
          <div class="deck-editor-row">
            <span class="de-name"><span class="de-titleline">🐭 招かれざる客<span class="de-max">（最大${CONFIG.deckCardMax}枚）</span></span><span class="de-desc">ネズミが相手の薬瓶を1つ壊す（中身は相手の捨て札へ）</span></span>
            <span class="de-stepper">
              <button type="button" class="de-step" data-card="jama" data-delta="-1">−</button>
              <b id="de-jama">${deckPrefs.jama || 0}</b>
              <button type="button" class="de-step" data-card="jama" data-delta="1">＋</button>
            </span>
          </div>` : ""}

          <div class="de-section-title">生薬カード
            <span class="de-presets">
              <button type="button" id="de-omakase" class="de-preset-btn primary">おまかせ（初心者用）</button>
              <button type="button" id="de-flat3" class="de-preset-btn">各3枚にする</button>
            </span>
          </div>
          <p class="de-note">初期は「おまかせ」＝このテーマを全部クリアできる最低枚数。0にすると外せます（上級者向け）。</p>
          <div id="deck-editor-herbs"></div>
          <p class="de-total" id="deck-total"></p>
        </div>`;
  }

  // デッキ編集UIのイベント配線（テーマは selectedThemes を参照）
  function wireDeckEditor(root) {
    root.querySelectorAll(".de-step").forEach(b => b.addEventListener("click", () => {
      const card = b.dataset.card;
      const next = deckPrefs[card] + Number(b.dataset.delta);
      deckPrefs[card] = Math.max(0, Math.min(CONFIG.deckCardMax, next));
      const el = document.querySelector("#de-" + card);
      if (el) el.textContent = deckPrefs[card];
      updateDeckTotal();
    }));
    root.querySelector("#de-omakase")?.addEventListener("click", () => {
      if (selectedThemes.length === 0) return;
      deckPrefs.herbs = guaranteeCounts(selectedThemes);
      renderDeckEditor();
    });
    root.querySelector("#de-flat3")?.addEventListener("click", () => {
      if (selectedThemes.length === 0) return;
      themeSelection(selectedThemes).herbIds.forEach(id => deckPrefs.herbs[id] = CONFIG.deckCopies);
      renderDeckEditor();
    });
    renderDeckEditor();
    updateDeckTotal();
  }

  // 生薬エディタ（テーマに応じて動的）を描画
  function renderDeckEditor() {
    const body = document.querySelector("#deck-editor-herbs");
    if (!body) return;
    const ids = selectedThemes;
    if (ids.length === 0) {
      body.innerHTML = `<p class="de-note">テーマを選ぶと、生薬の枚数を編集できます。</p>`;
      updateDeckTotal();
      return;
    }
    const sel = themeSelection(ids);
    body.innerHTML = sel.herbIds.map(id => {
      const h = herbById[id];
      const n = herbCountOf(id);
      return `
        <div class="de-herb ${n === 0 ? "de-herb-off" : ""}">
          <span class="de-hname">${h.name}<span class="de-hkana">${h.kana}</span></span>
          <span class="de-stepper">
            <button type="button" class="de-hstep" data-herb="${id}" data-delta="-1">−</button>
            <b id="deh-${id}">${n}</b>
            <button type="button" class="de-hstep" data-herb="${id}" data-delta="1">＋</button>
          </span>
        </div>`;
    }).join("");
    body.querySelectorAll(".de-hstep").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.herb;
      const next = Math.max(0, Math.min(CONFIG.herbMax, herbCountOf(id) + Number(b.dataset.delta)));
      deckPrefs.herbs[id] = next;
      const span = document.querySelector("#deh-" + id);
      if (span) {
        span.textContent = next;
        span.closest(".de-herb").classList.toggle("de-herb-off", next === 0);
      }
      updateDeckTotal();
    }));
    updateDeckTotal();
  }

  // 免責への同意ゲート（公開版=requireConsent時に、起動直後に表示）。同意するまで先へ進めない。
  function showConsentGate() {
    const app = $("#app");
    app.innerHTML = `
      <div class="consent-screen">
        <h1>学んで効く！<span>漢方カードバトル</span>${CONFIG.editionLabel ? `<span class="edition-badge">${CONFIG.editionLabel}</span>` : ""}</h1>
        <div class="consent-box">
          <p class="consent-lead">はじめる前に、下記をお読みください。</p>
          <p class="consent-text">⚠ 本アプリは漢方を楽しく学ぶための教育・娯楽目的の試作です。医療上の診断・治療・処方の助言ではありません。体調不良は医師・薬剤師にご相談ください。生薬の性質・方剤の効能などの記載は学習用のたたき台で、監修中の内容を含みます。</p>
          <label class="consent-check">
            <input type="checkbox" id="consent-checkbox"> <span>上記に同意します</span>
          </label>
          <button id="consent-btn" class="primary-btn" disabled>遊びはじめる</button>
        </div>
      </div>
      <div id="toast" class="toast hidden"></div>`;
    const cb = $("#consent-checkbox"), btn = $("#consent-btn");
    cb.addEventListener("change", () => { btn.disabled = !cb.checked; });
    btn.addEventListener("click", () => { if (cb.checked) showStartScreen(); });
  }

  function showStartScreen() {
    const app = $("#app");
    app.innerHTML = `
      <div class="start-screen">
        <h1>学んで効く！<span>漢方カードバトル</span>${CONFIG.editionLabel ? `<span class="edition-badge">${CONFIG.editionLabel}</span>` : ""}</h1>
        <div class="mode-select">
          <button type="button" class="mode-btn ${selectedMode === "solo" ? "selected" : ""}" data-mode="solo">🧑 ソロ</button>
          <button type="button" class="mode-btn ${selectedMode === "vs" ? "selected" : ""}" data-mode="vs">🧑‍🤝‍🧑 2人対戦</button>
        </div>
        <p class="mode-note">${selectedMode === "vs"
          ? "同じ端末を交代で使います（目隠し→交代）。同じお題を先に解いた方が高得点。"
          : "1人でじっくり。テーマの症状を解いて診療結果をめざします。"}</p>
        <p class="start-lead">今回あそぶ<b>テーマ</b>を選んでください。選んだテーマの症状だけが出て、
          デッキもそのテーマに必要な生薬だけで組まれます。<br>
          テーマを多く選ぶほどデッキが薄まり、<b>難しく</b>なります。</p>
        <div class="theme-list">
          ${themes.map(t => {
            const n = formulas.filter(f => f.theme === t.id).length;
            return `
              <label class="theme-item">
                <input type="checkbox" class="theme-check" value="${t.id}" ${selectedThemes.includes(t.id) ? "checked" : ""}>
                <span class="theme-body">
                  <span class="theme-name">${t.name} <span class="theme-count">${n}方剤</span></span>
                  <span class="theme-desc">${t.desc}</span>
                </span>
                <button type="button" class="detail-btn" data-detail="${t.id}">詳細</button>
              </label>`;
          }).join("")}
        </div>
        ${selectedMode === "solo" ? deckEditorHTML() : `
        <p class="vs-setup-hint">対戦では、このあと<b>各プレイヤーが自分の名前とデッキ</b>を設定します（相手には見えません）。</p>`}
        <p class="start-note" id="start-note"></p>
        <button id="start-btn" class="primary-btn">${selectedMode === "vs" ? "プレイヤーの準備へ →" : "この内容であそぶ"}</button>
        ${CONFIG.requireConsent ? "" : `<p class="disclaimer">⚠ 本アプリは漢方を楽しく学ぶための教育・娯楽目的の試作です。医療上の診断・治療・処方の助言ではありません。体調不良は医師・薬剤師にご相談ください。生薬の性質・方剤の効能などの記載は学習用のたたき台で、監修中の内容を含みます。</p>`}
      </div>
      <div id="toast" class="toast hidden"></div>
    `;

    const refresh = () => {
      const ids = getCheckedThemes();
      selectedThemes = ids;                 // 選択テーマを保持（モード切替の再描画で復元）
      const note = $("#start-note");
      const btn = $("#start-btn");
      if (ids.length === 0) {
        note.textContent = "テーマを1つ以上選んでください。";
        btn.disabled = true;
        renderDeckEditor();
        return;
      }
      const sel = themeSelection(ids);
      const rounds = Math.min(sel.activeSymptoms.length, CONFIG.maxRounds);
      note.textContent = `お題 ${rounds} 問／デッキに入る生薬 ${sel.herbIds.length} 種（全27種中）`;
      btn.disabled = false;
      // テーマが変わったら「おまかせ（最低保証）」を既定でロード（手動編集はリセット）
      deckPrefs.herbs = guaranteeCounts(ids);
      renderDeckEditor();
    };

    app.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => {
      selectedThemes = getCheckedThemes();          // 選択テーマを保持
      selectedMode = b.dataset.mode === "vs" ? "vs" : "solo";
      showStartScreen();                            // 再描画（対戦はデッキ編集を隠す）
    }));
    app.querySelectorAll(".theme-check").forEach(el => el.addEventListener("change", refresh));
    app.querySelectorAll("[data-detail]").forEach(b => b.addEventListener("click", (e) => {
      e.preventDefault();   // ラベル内のボタンなのでチェックのトグルを止める
      e.stopPropagation();
      openThemeDetail(b.dataset.detail);
    }));
    if (selectedMode === "solo") wireDeckEditor(app);   // ソロのデッキ編集を配線
    $("#start-btn").addEventListener("click", () => {
      const ids = getCheckedThemes();
      if (ids.length === 0) return;
      selectedThemes = ids;
      if (selectedMode === "vs") startVsSetup(ids);     // 対戦：各自の準備画面へ
      else newGame(ids, "solo");
    });
    refresh();
  }

  // ---- 対戦：各プレイヤーの準備（名前＋デッキ編集）を1人ずつ ----------
  let vsSetup = null; // [{name, prefs}, {name, prefs}]
  function startVsSetup(themeIds) {
    selectedThemes = themeIds.slice();
    vsSetup = [{ name: "", prefs: null }, { name: "", prefs: null }];
    deckPrefs = vsDefaultPrefs(themeIds);
    showVsSetup(0);
  }
  // 対戦の準備画面での初期デッキ（お邪魔カードも含む）
  const vsDefaultPrefs = (themeIds) => ({
    harvest: CONFIG.harvestCardCopies, daishukaku: CONFIG.bigHarvestCardCopies,
    jama: CONFIG.jamaCardCopies, herbs: guaranteeCounts(themeIds),
  });
  // クローン（各プレイヤーのデッキ編集を独立保存するため）
  const clonePrefs = (p) => ({ harvest: p.harvest, daishukaku: p.daishukaku, jama: p.jama || 0, herbs: { ...p.herbs } });

  function showVsSetup(i) {
    const app = $("#app");
    const isLast = i === 1;
    app.innerHTML = `
      <div class="start-screen">
        <button type="button" id="vs-back-btn" class="ghost-btn vs-back-btn">← テーマ選択へ戻る</button>
        <h1>対戦の準備<span class="edition-badge">プレイヤー${i + 1}</span></h1>
        <p class="mode-note">名前を入れて、あなたのデッキを編集してください（相手には見えません）。</p>
        <label class="vs-name-row">お名前：
          <input type="text" id="vs-name" class="vs-name-input" maxlength="12" placeholder="プレイヤー${i + 1}" value="${vsSetup[i].name}">
        </label>
        ${deckEditorHTML(true)}
        <p class="start-note" id="start-note"></p>
        <button id="vs-setup-btn" class="primary-btn">${isLast ? "対戦を始める" : "決定（プレイヤー2の準備へ）→"}</button>
      </div>
      <div id="toast" class="toast hidden"></div>`;
    wireDeckEditor(app);
    // テーマを変えたくなったら、いつでもテーマ選択へ戻れる（対戦モード・選択テーマは保持）
    $("#vs-back-btn").addEventListener("click", () => showStartScreen());
    $("#vs-setup-btn").addEventListener("click", () => {
      vsSetup[i].name = ($("#vs-name").value || "").trim() || `プレイヤー${i + 1}`;
      vsSetup[i].prefs = clonePrefs(deckPrefs);
      if (isLast) {
        newGame(selectedThemes, "vs", vsSetup);
      } else {
        // プレイヤー2用に既定デッキへリセットして、目隠しで交代
        deckPrefs = vsDefaultPrefs(selectedThemes);
        showSetupHandoff(1);
      }
    });
  }

  // 準備の交代（目隠し）：相手にデッキ編集を見られないよう受け渡す
  function showSetupHandoff(next) {
    const app = $("#app");
    app.innerHTML = `
      <div class="overlay handoff-overlay" style="position:static;min-height:70vh;">
        <div class="handoff-modal">
          <div class="handoff-icon">🙈</div>
          <p class="handoff-lead">準備を交代します</p>
          <p class="handoff-name">「プレイヤー${next + 1}」に画面を渡してください</p>
          <p class="handoff-note">相手のデッキが見えないよう、渡してから押してください。</p>
          <button id="setup-handoff-btn" class="primary-btn">プレイヤー${next + 1}：準備する</button>
        </div>
      </div>`;
    $("#setup-handoff-btn").addEventListener("click", () => showVsSetup(next));
  }

  // テーマの「詳細」：そのテーマの方剤一覧（構成生薬つき）をモーダル表示
  function openThemeDetail(themeId) {
    const theme = themes.find(t => t.id === themeId);
    if (!theme) return;
    // このテーマで「お題として問われる」方剤id（症状の正解がこのテーマの方剤）
    const asked = new Set(
      symptoms.map(primaryFormulaId)
        .filter(id => formulaById[id] && formulaById[id].theme === themeId)
    );
    // 味数の少ない順（土台→大きな方剤へ育つ流れが見える）
    const list = formulas
      .filter(f => f.theme === themeId)
      .sort((a, b) => a.herbs.length - b.herbs.length);

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="detail-modal">
        <div class="detail-title">${theme.name}<span>で出てくる方剤（${list.length}）</span></div>
        <p class="detail-lead">「出題」＝お題として問われる方剤。「土台」＝積み上げに使う方剤。</p>
        <div class="detail-list">
          ${list.map(f => {
            const isAsked = asked.has(f.id);
            return `
              <div class="detail-formula">
                <div class="detail-fhead">
                  <span class="detail-fname">${f.name}<span class="detail-fkana">${f.kana}</span></span>
                  <span class="detail-tag ${isAsked ? "tag-asked" : "tag-base"}">${isAsked ? "出題" : "土台"}</span>
                </div>
                <div class="detail-herbs">${f.herbs.map(id => herbById[id].name).join("・")}<span class="detail-count">（${f.herbs.length}味）</span></div>
              </div>`;
          }).join("")}
        </div>
        <button type="button" class="primary-btn detail-close">閉じる</button>
      </div>`;
    $("#app").appendChild(overlay);
    overlay.querySelector(".detail-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // 捨て札の中身を確認するモーダル（①生薬＝再利用可／②使用済み補助カード＝再利用不可）
  function openDiscardView() {
    if (!state.discard.length && !state.usedActions.length) {
      flash("捨て札はまだありません。", "warn"); return;
    }
    // ①生薬（大収穫で山札に戻せる）
    const herbCounts = {};
    state.discard.forEach(id => { herbCounts[id] = (herbCounts[id] || 0) + 1; });
    const herbIds = state.discard.filter((id, i) => state.discard.indexOf(id) === i).sort(byHerbOrder);
    const herbSection = `
      <div class="discard-section">
        <div class="discard-shead">生薬 <span>${state.discard.length}枚・大収穫で山札に戻せる</span></div>
        ${herbIds.length
          ? `<div class="discard-grid">${herbIds.map(id => {
              const h = herbById[id];
              return `<div class="discard-chip ${netsuClass[h.netsu]}"><span class="dc-name">${h.name}</span><span class="dc-count">×${herbCounts[id]}</span></div>`;
            }).join("")}</div>`
          : `<p class="discard-emptynote">まだ生薬を捨てていません。</p>`}
      </div>`;
    // ②使用済みの補助カード（再利用不可）
    const actCounts = {};
    state.usedActions.forEach(id => { actCounts[id] = (actCounts[id] || 0) + 1; });
    const actIds = state.usedActions.filter((id, i) => state.usedActions.indexOf(id) === i);
    const actSection = state.usedActions.length ? `
      <div class="discard-section">
        <div class="discard-shead used">使用済みカード <span>${state.usedActions.length}枚・再利用できません（山札に戻りません）</span></div>
        <div class="discard-grid">
          ${actIds.map(id => `<div class="discard-chip used-chip"><span class="dc-name">${ACTIONS[id].name}</span><span class="dc-count">×${actCounts[id]}</span></div>`).join("")}
        </div>
      </div>` : "";

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="detail-modal discard-modal">
        <div class="detail-title">捨て札<span>生薬${state.discard.length}枚／使用済み${state.usedActions.length}枚</span></div>
        ${herbSection}
        ${actSection}
        <button type="button" class="primary-btn detail-close">閉じる</button>
      </div>`;
    $("#app").appendChild(overlay);
    overlay.querySelector(".detail-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ---- カード操作の基盤 ------------------------------------------
  // 山札から手札を n 枚まで補充。新しく引いたカードの uid を配列で返す（登場アニメ用）
  function drawTo(n) {
    const added = [];
    while (state.hand.length < n && state.deck.length > 0) {
      const card = { uid: state.nextUid++, id: state.deck.pop() };
      state.hand.push(card);
      added.push(card.uid);
    }
    return added;
  }

  function nextRound() {
    state.round += 1;
    state.pot = { hand: [], bottles: [] };
    state.hintOpen = false;
    if (state.round > state.totalRounds || state.symptomPile.length === 0) {
      state.finished = true;
      state.currentSymptom = null;
      return;
    }
    state.currentSymptom = symptomById[state.symptomPile.pop()];
    if (state.mode === "vs") return; // 対戦：ドロー/手番は beginTurn 側で（呼び出し元が先手を決める）
    // ソロ：お題開始＝初手番。まず開幕を配り、少し間を置いて手番開始の+2
    state.roundTurn = 1;
    state.drewThisTurn = true;
    state.justDrawn = drawTo(Math.max(state.hand.length, CONFIG.handStart));
    scheduleStartDraw();
  }

  // 対戦：目隠し（交代）画面。相手に手札を見られないよう、渡してから表示する
  function showHandoff(next) {
    const overlay = document.createElement("div");
    overlay.className = "overlay handoff-overlay";
    overlay.innerHTML = `
      <div class="handoff-modal">
        <div class="handoff-icon">🙈</div>
        <p class="handoff-lead">手番を交代します</p>
        <p class="handoff-name">「${state.playerNames[next]}」に画面を渡してください</p>
        <p class="handoff-note">相手に手札を見られないよう、渡してから下のボタンを押してください。</p>
        <button id="handoff-btn" class="primary-btn">${state.playerNames[next]}：準備OK（表示する）</button>
      </div>`;
    $("#app").appendChild(overlay);
    document.getElementById("handoff-btn").addEventListener("click", () => {
      overlay.remove();
      beginTurn(next);
      render();
    });
  }

  const handByUid = (uid) => state.hand.find(c => c.uid === uid);
  const bottleByUid = (uid) => state.shelf.find(b => b.uid === uid);

  // 調合エリアの生薬集合（手札の生薬 ＋ 薬瓶の中身）
  function potHerbIds() {
    const fromHand = state.pot.hand.map(uid => handByUid(uid).id);
    const fromBottles = state.pot.bottles.flatMap(uid => bottleByUid(uid).herbs);
    return [...fromHand, ...fromBottles];
  }
  function potFormula() {
    const ids = potHerbIds();
    if (ids.length === 0) return null;
    return formulaByHerbKey[keyOf(ids)] || null;
  }
  function currentBonus() {
    return CONFIG.earlyBonus[state.roundTurn] || 0;
  }
  // 味数（構成生薬の数）に応じた薬味数ボーナス
  function sizeBonusFor(count) {
    for (const t of CONFIG.sizeBonus) if (count >= t.min) return t.add;
    return 0;
  }
  // この症状の「正解方剤」の味数（結果画面の満点計算に使う）
  function targetSizeOf(sym) {
    const f = formulaById[primaryFormulaId(sym)];
    return f ? f.herbs.length : 0;
  }

  // 調合エリアの中身を消費（手札・薬瓶から除去）
  function consumePot() {
    const handUids = new Set(state.pot.hand);
    const bottleUids = new Set(state.pot.bottles);
    state.hand = state.hand.filter(c => !handUids.has(c.uid));
    state.shelf = state.shelf.filter(b => !bottleUids.has(b.uid));
    state.pot = { hand: [], bottles: [] };
  }

  // ---- 操作ハンドラ ----------------------------------------------
  function toggleHandCard(uid) {
    if (state.finished) return;
    const pos = state.pot.hand.indexOf(uid);
    if (pos >= 0) state.pot.hand.splice(pos, 1);
    else state.pot.hand.push(uid);
    render();
  }

  function toggleBottle(uid) {
    if (state.finished) return;
    const pos = state.pot.bottles.indexOf(uid);
    if (pos >= 0) state.pot.bottles.splice(pos, 1);
    else state.pot.bottles.push(uid);
    render();
  }

  function discardCard(uid) {
    if (state.finished) return;
    const card = handByUid(uid);
    // 捨て札置き場は生薬専用（収穫/大収穫で山札へ戻せる）。補助カードは消費して戻さない
    if (card && !isAction(card.id)) state.discard.push(card.id);
    else if (card && isAction(card.id)) state.usedActions.push(card.id); // 表示専用（再利用不可）
    state.pot.hand = state.pot.hand.filter(u => u !== uid);
    state.hand = state.hand.filter(c => c.uid !== uid);
    render();
  }

  // 「捨てる」要求。補助カードは再利用できないので確認ダイアログを挟む
  function requestDiscard(uid) {
    if (state.finished) return;
    const card = handByUid(uid);
    if (card && isAction(card.id)) {
      const a = ACTIONS[card.id];
      confirmModal(
        `「${a.name}」は補助カードです。<br>捨てると<b>再利用できません</b>（大収穫でも山札に戻りません）。<br>捨てますか？`,
        "捨てる", () => discardCard(uid));
    } else {
      discardCard(uid);
    }
  }

  // 汎用の確認ダイアログ（OKで onOk を実行）
  function confirmModal(messageHTML, okLabel, onOk) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="confirm-modal">
        <p class="confirm-text">${messageHTML}</p>
        <div class="confirm-buttons">
          <button type="button" class="ghost-btn" id="confirm-cancel">やめる</button>
          <button type="button" class="primary-btn danger" id="confirm-ok">${okLabel}</button>
        </div>
      </div>`;
    $("#app").appendChild(overlay);
    overlay.querySelector("#confirm-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector("#confirm-ok").addEventListener("click", () => { overlay.remove(); onOk(); });
  }

  // 大収穫カードを使う：捨て札の生薬をすべて山札に戻してシャッフル（カードは消費）
  function useBigHarvest(cardUid) {
    if (state.finished) return;
    const card = handByUid(cardUid);
    if (!card || card.id !== "act:daishukaku") return;
    if (state.discard.length === 0) { flash("捨て札がありません。今は使えません。", "warn"); return; }
    const n = state.discard.length;
    state.deck = shuffle(state.deck.concat(state.discard));
    state.discard = [];
    // 使った大収穫カードは消費（捨て札には積まない＝自分自身が戻ってこない）
    state.hand = state.hand.filter(c => c.uid !== cardUid);
    state.pot.hand = state.pot.hand.filter(u => u !== cardUid);
    state.usedActions.push("act:daishukaku"); // 消費記録（表示専用・再利用不可）
    flash(`大収穫：捨て札 ${n} 枚を山札に戻しました。`, "ok");
    render();
  }

  // お邪魔カード（招かれざる客）：相手の薬瓶を1つランダムで壊す（中身の生薬は相手の捨て札へ）
  function useJama(cardUid) {
    if (state.finished || state.mode !== "vs") return;
    const card = handByUid(cardUid);
    if (!card || card.id !== "act:jama") return;
    const opp = 1 - state.active;
    const oppBoard = state.players[opp];
    if (!oppBoard.shelf || oppBoard.shelf.length === 0) {
      flash(`${state.playerNames[opp]} の薬瓶がありません。今は使えません。`, "warn");
      return; // 対象がなければ消費しない（無駄打ち防止）
    }
    // ランダムで1つ選んで破壊
    const idx = Math.floor(Math.random() * oppBoard.shelf.length);
    const [bottle] = oppBoard.shelf.splice(idx, 1);
    const f = formulaById[bottle.formulaId];
    oppBoard.discard = oppBoard.discard.concat(bottle.herbs); // 中身は相手の捨て札へ（大収穫で復活可）
    // 壊された薬瓶名を通知にためる（相手が手番を取ったとき、割れる演出で知らせる）
    oppBoard.notice = (oppBoard.notice || []).concat(f ? f.name : "薬瓶");
    // 使ったお邪魔カードは消費
    state.hand = state.hand.filter(c => c.uid !== cardUid);
    state.pot.hand = state.pot.hand.filter(u => u !== cardUid);
    state.usedActions.push("act:jama");
    flash(`🐭 招かれざる客！ ${state.playerNames[opp]} の薬瓶「${f ? f.name : "?"}」を壊した！`, "ok");
    render();
  }

  // ドロー：1手番に1回だけ2枚引く（手札は一時的に handHard まで持てる）
  // 収穫カードを使う：山札にある生薬を指名して手札に加えるモーダルを開く
  function openHarvestPicker(cardUid) {
    if (state.finished) return;
    const card = handByUid(cardUid);
    if (!card || card.id !== "act:harvest") return;

    // 山札にある生薬の種類と残数
    const counts = {};
    for (const id of state.deck) { if (!isAction(id)) counts[id] = (counts[id] || 0) + 1; }
    const types = Object.keys(counts).sort(byHerbOrder);
    if (types.length === 0) { flash("山札に生薬がありません。", "warn"); return; }
    // 選べる最大数：定数（harvestPick）と山札の在庫の小さい方。手札の空きでは制限しない
    // （大型方剤を一気に集める切り札。超過分はターン終了時に10枚まで捨てて調整する）
    const deckHerbCount = types.reduce((sum, id) => sum + counts[id], 0);
    const maxPick = Math.max(1, Math.min(CONFIG.harvestPick, deckHerbCount));

    const picked = []; // 選んだ生薬id（重複可）
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    $("#app").appendChild(overlay);

    const remaining = (id) => counts[id] - picked.filter(p => p === id).length;

    function draw() {
      const chips = types.map(id => {
        const h = herbById[id];
        const rem = remaining(id);
        const disabled = rem <= 0 || picked.length >= maxPick;
        return `<button class="pick-herb ${netsuClass[h.netsu]}" data-pick="${id}" ${disabled ? "disabled" : ""}>
            <span class="pick-name">${h.name}</span><span class="pick-rem">山札${rem}</span>
          </button>`;
      }).join("");
      const chosen = picked.length
        ? picked.map((id, i) => `<span class="chosen-herb" data-unpick="${i}">${herbById[id].name} ✕</span>`).join("")
        : `<span class="pick-empty">まだ選んでいません</span>`;
      overlay.innerHTML = `
        <div class="harvest-modal">
          <div class="harvest-title">収穫：山札から生薬を指名（最大 ${maxPick} 枚）</div>
          <div class="harvest-chosen">選んだ生薬（${picked.length}/${maxPick}）：${chosen}</div>
          <div class="harvest-pool">${chips}</div>
          <div class="harvest-buttons">
            <button id="harvest-ok" class="primary-btn" ${picked.length ? "" : "disabled"}>この生薬を手札へ（${picked.length}枚）</button>
            <button id="harvest-cancel" class="ghost-btn">やめる</button>
          </div>
        </div>`;
      overlay.querySelectorAll("[data-pick]").forEach(b =>
        b.addEventListener("click", () => {
          if (picked.length >= maxPick) return;
          if (remaining(b.dataset.pick) <= 0) return;
          picked.push(b.dataset.pick); draw();
        }));
      overlay.querySelectorAll("[data-unpick]").forEach(b =>
        b.addEventListener("click", () => { picked.splice(Number(b.dataset.unpick), 1); draw(); }));
      overlay.querySelector("#harvest-cancel").addEventListener("click", () => overlay.remove());
      overlay.querySelector("#harvest-ok").addEventListener("click", () => {
        if (!picked.length) return;
        picked.forEach(id => { if (removeFromDeck(id)) state.hand.push({ uid: state.nextUid++, id }); });
        // 使った収穫カードは手札から取り除いて消費（捨て札には積まない＝収穫/大収穫で戻さない）
        state.hand = state.hand.filter(c => c.uid !== cardUid);
        state.pot.hand = state.pot.hand.filter(u => u !== cardUid);
        state.usedActions.push("act:harvest"); // 消費記録（表示専用・再利用不可）
        overlay.remove();
        flash(`収穫：${picked.length}枚の生薬を手札に加えました。`, "ok");
        render();
      });
    }
    draw();
  }

  // ターンを終える：手番を1つ進める（対戦では相手に手番を譲る）。次の手番の開始で自動ドローされる。
  // 手札が「やわらかい上限(handSoft)」を超えていたら、まず自分で捨てさせる
  function endTurn() {
    if (state.finished) return;
    if (state.hand.length > CONFIG.handSoft) {
      flash(`手札を ${CONFIG.handSoft} 枚までに。あと ${state.hand.length - CONFIG.handSoft} 枚 捨ててからターンを終えてください。`, "warn");
      return;
    }
    state.roundTurn += 1;
    state.pot = { hand: [], bottles: [] };
    if (state.mode === "vs") { state.drewThisTurn = false; handoffTo(1 - state.active); return; } // 相手へ（相手の手番開始で自動ドロー）
    // ソロ：手番を切り替えて表示 → 少し間を置いて+2ドロー
    state.drewThisTurn = true;
    render();
    scheduleStartDraw();
  }

  // 調合中の方剤を薬瓶に確保（棚へ）— お題をまたいで再利用できる
  function bottlePot() {
    const f = potFormula();
    if (!f) { flash("この組み合わせは既知の方剤に一致しません。", "warn"); return; }
    consumePot();
    state.shelf.push({ uid: state.nextUid++, formulaId: f.id, herbs: f.herbs.slice() });
    flash(`「${f.name}」を薬瓶に確保しました。`, "ok");
    render();
  }

  // 調合中の方剤をお題に提出（患者へ）— 消費してラウンド終了
  function submitPot() {
    if (state.finished || !state.currentSymptom) return;
    const f = potFormula();
    if (!f) { flash("既知の方剤に一致しません。過不足を見直しましょう。", "warn"); return; }
    const match = state.currentSymptom.score[f.id] || 0;
    const bonus = match > 0 ? currentBonus() : 0;             // マッチ0なら早解き無効
    const sizeBonus = match > 0 ? sizeBonusFor(f.herbs.length) : 0; // マッチ0なら薬味数ボーナスも無効
    const total = match + bonus + sizeBonus;
    state.score += total;
    // この回の満点＝証3＋早解き最大＋（正解方剤の薬味数ボーナス）
    const roundMax = 3 + (CONFIG.earlyBonus[1] || 0) + sizeBonusFor(targetSizeOf(state.currentSymptom));
    state.log.push({
      round: state.round,
      symptomText: state.currentSymptom.text,
      formulaName: f.name,
      match, bonus, sizeBonus, total, roundMax,
    });
    consumePot();
    if (state.mode === "vs") {
      // 対戦：先に解いた側がこのお題を獲得。次のお題は勝者が「後攻」＝相手が先手。
      showRoundResult(f, match, bonus, sizeBonus, total, () => {
        const winner = state.active;
        nextRound();
        if (state.finished) { saveBoard(winner); render(); return; }
        handoffTo(1 - winner);
      });
      return;
    }
    showRoundResult(f, match, bonus, sizeBonus, total, () => { nextRound(); render(); });
  }

  // このお題を見送る（ソロ=0点で次へ／対戦=両者スキップで次のお題へ）
  function passRound() {
    if (state.finished || !state.currentSymptom) return;
    if (state.mode === "vs") {
      const other = 1 - state.active;
      nextRound();
      if (state.finished) { saveBoard(state.active); render(); return; }
      handoffTo(other); // 相手が次のお題の先手
      return;
    }
    state.log.push({
      round: state.round,
      symptomText: state.currentSymptom.text,
      formulaName: "（見送り）",
      match: 0, bonus: 0, sizeBonus: 0, total: 0,
      roundMax: 3 + (CONFIG.earlyBonus[1] || 0) + sizeBonusFor(targetSizeOf(state.currentSymptom)),
    });
    nextRound();
    render();
  }

  function toggleHint() {
    state.hintOpen = !state.hintOpen;
    render();
  }

  // ---- 描画 -------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  // drawIndex: 直近ドローで引いたカードなら 0,1,2… の順番（登場アニメの段差用）。そうでなければ null
  function herbCardHTML(card, isSelected, drawIndex) {
    const h = herbById[card.id];
    const anim = drawIndex != null ? ` just-drawn" style="--dd:${drawIndex * 110}ms` : "";
    return `
      <div class="herb-card ${netsuClass[h.netsu]} ${isSelected ? "selected" : ""}${anim}"
           data-uid="${card.uid}">
        <div class="herb-top">
          <span class="herb-netsu">${h.netsu}</span>
          <span class="herb-kbs">${h.kbs.join("・")}</span>
        </div>
        <div class="herb-name">${h.name}</div>
        <div class="herb-kana">${h.kana}</div>
        <div class="herb-copy">${h.copy}</div>
        <button class="redraw-btn" data-discard="${card.uid}" title="この生薬を捨てる">捨てる</button>
      </div>`;
  }

  function actionCardHTML(card, drawIndex) {
    const a = ACTIONS[card.id];
    const kind = card.id === "act:daishukaku" ? "action-big" : card.id === "act:jama" ? "action-jama" : "action-harvest";
    const anim = drawIndex != null ? ` just-drawn" style="--dd:${drawIndex * 110}ms` : "";
    return `
      <div class="herb-card action-card ${kind}${anim}" data-uid="${card.uid}">
        <div class="herb-top"><span class="action-badge">${card.id === "act:jama" ? "お邪魔カード" : "補助カード"}</span></div>
        <div class="herb-name">${a.name}</div>
        <div class="herb-kana">${a.kana}</div>
        <div class="herb-copy">${a.copy}</div>
        <button class="use-action-btn" data-use="${card.uid}">使う</button>
        <button class="redraw-btn" data-discard="${card.uid}" title="このカードを捨てる">捨てる</button>
      </div>`;
  }

  function bottleCardHTML(bottle, isSelected) {
    const f = formulaById[bottle.formulaId];
    return `
      <div class="bottle-card ${isSelected ? "selected" : ""}" data-bottle="${bottle.uid}">
        <div class="bottle-cap"></div>
        <div class="bottle-name">${f.name}</div>
        <div class="bottle-kana">${f.kana}</div>
        <div class="bottle-herbs">${bottle.herbs.map(id => herbById[id].name).join("・")}</div>
      </div>`;
  }

  function render() {
    const app = $("#app");

    if (state.finished) {
      app.innerHTML = state.mode === "vs" ? vsResultScreenHTML() : resultScreenHTML();
      $("#restart-btn").addEventListener("click", showStartScreen);
      return;
    }

    const s = state.currentSymptom;
    const target = s.score
      ? Object.entries(s.score).sort((a, b) => b[1] - a[1])[0]
      : null;
    const targetFormula = target ? formulaById[target[0]] : null;

    const pf = potFormula();
    const potIds = potHerbIds();
    const potEmpty = potIds.length === 0;
    const bonus = currentBonus();

    // 直近ドローで引いたカードの登場順（山札から配られる登場アニメの段差用）
    const drawnOrder = {};
    (state.justDrawn || []).forEach((uid, i) => { drawnOrder[uid] = i; });
    const justDrew = (state.justDrawn || []).length > 0;
    // 捨て札の山は「数字だけ」表示（詳細はクリックで2区分表示）。数＝生薬＋使用済み補助カード
    const discTotal = state.discard.length + state.usedActions.length;

    // 調合エリアの中身チップ
    const potPieces =
      state.pot.bottles.map(uid => {
        const f = formulaById[bottleByUid(uid).formulaId];
        return `<span class="pot-piece pot-bottle">🫙 ${f.name}</span>`;
      }).join("") +
      state.pot.hand.map(uid => {
        const h = herbById[handByUid(uid).id];
        return `<span class="pot-piece">${h.name}</span>`;
      }).join("");

    const detection = potEmpty
      ? `<span class="pot-empty">手札の生薬や棚の薬瓶を選んで、方剤を組み立てましょう</span>`
      : pf
        ? `<span class="pot-ok">✓ <b>${pf.name}</b> が成立（${pf.herbs.length}味${sizeBonusFor(pf.herbs.length) > 0 ? `・薬味数ボーナス+${sizeBonusFor(pf.herbs.length)}` : ""}）</span>`
        : `<span class="pot-ng">未成立：${uniq(potIds).length}種 — 既知の方剤に一致しません（過不足に注意）</span>`;

    app.innerHTML = `
      <header class="topbar">
        <div class="brand">学んで効く！<span>漢方カードバトル</span>${CONFIG.editionLabel ? `<span class="edition-badge">${CONFIG.editionLabel}</span>` : ""}</div>
        <div class="stats">
          <span class="stat">お題 <b>${state.round}</b>/${state.totalRounds}</span>
          <span class="stat">ターン <b>${state.roundTurn}</b></span>
          <span class="stat">得点 <b>${state.score}</b></span>
          <span class="stat stat-deck ${justDrew ? "deck-pulse" : ""}">山札 <b>${state.deck.length}</b></span>
          <span class="stat">捨て札 <b>${state.discard.length}</b></span>
        </div>
      </header>

      ${state.mode === "vs" ? `
      <section class="vs-bar">
        <div class="vs-player ${state.active === 0 ? "active" : ""}">
          <span class="vs-name">${state.playerNames[0]}</span><b class="vs-score">${scoreOf(0)}</b>
          <span class="vs-sub">🫙${shelfCountOf(0)}・🂠${handCountOf(0)}</span>
        </div>
        <div class="vs-turn">🎯 ${state.playerNames[state.active]} の番</div>
        <div class="vs-player ${state.active === 1 ? "active" : ""}">
          <span class="vs-name">${state.playerNames[1]}</span><b class="vs-score">${scoreOf(1)}</b>
          <span class="vs-sub">🫙${shelfCountOf(1)}・🂠${handCountOf(1)}</span>
        </div>
      </section>` : ""}

      <section class="symptom-card">
        <div class="symptom-label">症状カード（患者さんの訴え）</div>
        <p class="symptom-text">${s.text}</p>
        <div class="symptom-meta">
          <span class="bonus-chip ${bonus > 0 ? "" : "zero"}">今提出すると 早解き <b>+${bonus}</b></span>
          <button id="hint-btn" class="ghost-btn">${state.hintOpen ? "ヒントを隠す" : "ヒントを見る"}</button>
        </div>
        ${state.hintOpen ? `
          <div class="hint-box">
            <p>💡 ${s.hint}</p>
            <p class="hint-answer">想定処方：<b>${targetFormula.name}</b>（${targetFormula.kana}）<br>
            構成生薬：${targetFormula.herbs.map(id => herbById[id].name).join("・")}</p>
          </div>` : ""}
      </section>

      <section class="shelf-area">
        <div class="shelf-label">薬瓶の棚（確保した方剤・お題をまたいで使える）</div>
        <div class="shelf-grid">
          ${state.shelf.length
            ? state.shelf.map(b => bottleCardHTML(b, state.pot.bottles.includes(b.uid))).join("")
            : `<span class="shelf-empty">まだ薬瓶はありません。方剤を組んで「薬瓶に確保」すると、ここに残せます。</span>`}
        </div>
      </section>

      <section class="mixing-area">
        <div class="mixing-label">調合エリア</div>
        <div class="mixing-content">${potPieces || ""}</div>
        <div class="mixing-detect">${detection}</div>
        <div class="mixing-buttons">
          <button id="submit-btn" class="primary-btn" ${pf ? "" : "disabled"}>この方剤で提出（患者へ）</button>
          <button id="bottle-btn" class="accent-btn" ${pf ? "" : "disabled"}>薬瓶に確保（棚へ残す）</button>
          <button id="clear-btn" class="ghost-btn" ${potEmpty ? "disabled" : ""}>選択をクリア</button>
        </div>
      </section>

      <section class="turn-bar">
        <div class="pile-wrap">
          <div class="deck-pile ${state.deck.length === 0 ? "empty" : ""} ${justDrew ? "deck-pulse" : ""}"
               title="山札（残り ${state.deck.length} 枚）" aria-hidden="true">
            <span class="deck-pile-count">${state.deck.length}</span>
          </div>
          <span class="pile-label">山札</span>
        </div>
        <div class="pile-wrap">
          <div class="discard-pile ${discTotal === 0 ? "empty" : ""}" id="discard-pile"
               title="捨て札（クリックで中身を確認）">
            <span class="discard-pile-count">${discTotal}</span>
          </div>
          <span class="pile-label">捨て札</span>
        </div>
        <button id="end-turn-btn" class="accent-btn"
          ${state.hand.length > CONFIG.handSoft ? "disabled" : ""}>
          ターンを終える（次の手番へ・自動で+2枚・早解き -1）
        </button>
        <button id="pass-btn" class="ghost-btn danger">${state.mode === "vs" ? "このお題を流す（両者0点で次へ）" : "このお題を見送る（0点）"}</button>
      </section>

      <section class="hand-area">
        <div class="hand-label">手札（生薬カード）— ${state.hand.length}/${CONFIG.handSoft}枚${state.hand.length > CONFIG.handSoft ? `（あと${state.hand.length - CONFIG.handSoft}枚 捨ててターン終了）` : ""}</div>
        <div class="hand-grid">
          ${state.hand.map(c => isAction(c.id)
            ? actionCardHTML(c, drawnOrder[c.uid] != null ? drawnOrder[c.uid] : null)
            : herbCardHTML(c, state.pot.hand.includes(c.uid), drawnOrder[c.uid] != null ? drawnOrder[c.uid] : null)).join("")}
        </div>
      </section>

      <div id="toast" class="toast hidden"></div>
    `;

    // 引いたカードが横スクロールの右に隠れないよう、手札を右端へ寄せる
    if (justDrew) { const hg = $(".hand-grid"); if (hg) hg.scrollLeft = hg.scrollWidth; }
    // 登場アニメは一度きり：この後の再描画（カード選択など）で再生されないようクリア
    state.justDrawn = [];

    // イベント登録
    app.querySelectorAll(".herb-card").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".redraw-btn") || e.target.closest(".use-action-btn")) return;
        if (el.classList.contains("action-card")) return; // 補助カードは調合に入れない
        toggleHandCard(Number(el.dataset.uid));
      });
    });
    app.querySelectorAll("[data-use]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const uid = Number(btn.dataset.use);
        const card = handByUid(uid);
        if (!card) return;
        if (card.id === "act:harvest") openHarvestPicker(uid);
        else if (card.id === "act:daishukaku") useBigHarvest(uid);
        else if (card.id === "act:jama") useJama(uid);
      });
    });
    app.querySelectorAll("[data-discard]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        requestDiscard(Number(btn.dataset.discard));
      });
    });
    app.querySelectorAll(".bottle-card").forEach(el => {
      el.addEventListener("click", () => toggleBottle(Number(el.dataset.bottle)));
    });
    $("#submit-btn").addEventListener("click", submitPot);
    $("#bottle-btn").addEventListener("click", bottlePot);
    $("#clear-btn").addEventListener("click", () => { state.pot = { hand: [], bottles: [] }; render(); });
    { const dp = $("#discard-pile"); if (dp) dp.addEventListener("click", openDiscardView); }
    $("#end-turn-btn").addEventListener("click", endTurn);
    $("#pass-btn").addEventListener("click", passRound);
    $("#hint-btn").addEventListener("click", toggleHint);
  }

  function flash(msg, type) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast ${type || ""}`;
    setTimeout(() => { toast.className = "toast hidden"; }, 2600);
  }

  // 提出結果をモーダル表示 → 次のお題へ
  function showRoundResult(formula, match, bonus, sizeBonus, total, onNext) {
    const app = $("#app");
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const gradeClass = match === 3 ? "grade-3" : match === 2 ? "grade-2" : match === 1 ? "grade-1" : "grade-0";
    const whoHTML = state.mode === "vs" ? `<div class="result-who">${state.playerNames[state.active]} が獲得！</div>` : "";
    overlay.innerHTML = `
      <div class="result-modal ${gradeClass}">
        ${whoHTML}
        <div class="result-formula">${formula.name}<span>${formula.kana}</span></div>
        <div class="result-grade">${matchLabel[match]}</div>
        <div class="result-score-break">
          <span>症状マッチ <b>+${match}</b></span>
          <span>早解き <b>+${bonus}</b></span>
          <span>薬味数（${formula.herbs.length}味） <b>+${sizeBonus}</b></span>
        </div>
        <div class="result-points">合計 +${total}<span>点</span></div>
        <p class="result-note">${formula.note || ""}</p>
        <p class="result-genten">出典：${formula.genten || "―"}${formula.base && formulaById[formula.base] ? `／類方：${formulaById[formula.base].name}` : ""}</p>
        <button id="next-btn" class="primary-btn">${state.mode === "vs" ? "次のお題へ →" : "次の患者さんへ →"}</button>
      </div>`;
    app.appendChild(overlay);
    document.getElementById("next-btn").addEventListener("click", () => {
      overlay.remove();
      if (onNext) onNext();
      else { nextRound(); render(); }
    });
  }

  // 対戦の勝敗画面（合計点で勝敗）
  function vsResultScreenHTML() {
    const s0 = state.players[0].score, s1 = state.players[1].score;
    const winner = s0 === s1 ? null : (s0 > s1 ? 0 : 1);
    const title = winner === null ? "引き分け！" : `🏆 ${state.playerNames[winner]} の勝ち！`;
    return `
      <div class="result-modal vs-result grade-${winner === null ? 0 : 3}">
        <div class="vs-result-title">${title}</div>
        <div class="vs-result-scores">
          <div class="vs-result-p ${winner === 0 ? "win" : ""}"><span>${state.playerNames[0]}</span><b>${s0}</b>点</div>
          <div class="vs-result-mid">vs</div>
          <div class="vs-result-p ${winner === 1 ? "win" : ""}"><span>${state.playerNames[1]}</span><b>${s1}</b>点</div>
        </div>
        <p class="result-note">同じお題を早く正しく解いた側が得点。合計点で勝敗が決まります。</p>
        <button id="restart-btn" class="primary-btn">もう一度あそぶ</button>
      </div>`;
  }

  function resultScreenHTML() {
    // 満点＝各お題の満点（証3＋早解き最大＋正解方剤の薬味数ボーナス）の合計
    const fallbackMax = 3 + (CONFIG.earlyBonus[1] || 0);
    const max = state.log.reduce((s, l) => s + (l.roundMax || fallbackMax), 0);
    const rows = state.log.map(l => `
      <tr>
        <td>${l.round}</td>
        <td class="log-symptom">${l.symptomText}</td>
        <td>${l.formulaName}</td>
        <td class="log-pt pt-${Math.min(l.match, 3)}">${l.total}点（証${l.match}＋速${l.bonus}＋薬味${l.sizeBonus || 0}）</td>
      </tr>`).join("");
    let rank, comment;
    const ratio = max ? state.score / max : 0;
    if (ratio >= 0.85)      { rank = "名医"; comment = "証を的確に見極め、手際よく調合する達人です！"; }
    else if (ratio >= 0.6)  { rank = "上級医"; comment = "しっかり証に合わせ、素早く仕上げられています。"; }
    else if (ratio >= 0.35) { rank = "研修医"; comment = "方向性は合格。類方の違いと段取りを磨きましょう。"; }
    else                    { rank = "見習い"; comment = "ヒントを活用し、症状と処方の対応・薬瓶の使い方を覚えていきましょう。"; }

    return `
      <div class="end-screen">
        <h1>診療結果</h1>
        <div class="end-score">
          <div class="end-total">${state.score}<span> / ${max} 点</span></div>
          <div class="end-rank">称号：<b>${rank}</b></div>
          <p class="end-comment">${comment}</p>
        </div>
        <table class="log-table">
          <thead><tr><th>お題</th><th>症状</th><th>出した方剤</th><th>得点</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <button id="restart-btn" class="primary-btn">もう一度あそぶ</button>
      </div>`;
  }

  // ---- 起動 -------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    if (CONFIG.requireConsent) showConsentGate();
    else showStartScreen();
  });
})();
