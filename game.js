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
  const subgroups = window.KAMPO.subgroups || [];   // テーマ内の絞り込みグループ（無いビルドでも動くよう既定 []）

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
    visitorCost: 2,          // 「静かなる来訪者」を使うときに支払う得点（説明文に出すので お試し版にも残る）
    turnDrawDelayMs: 1200,   // 手番開始の自動ドロー(+2)を、配り/切替の少しあとに出す間（ms）
    deckCardMax: 3,     // デッキ編集で補助カードを入れられる上限（各種類）
    herbMax: 9,         // デッキ編集で生薬を入れられる上限（各種類。0にすると外せる）
    // この版では使えない補助カード（デッキ編集のキー名で指定。例：["visitor"]）。
    //   お試し版用。名前と説明は出るが 0枚固定で増やせない＝「そういうカードがあるんだ」だけ伝える“皮”。
    //   ※皮だけにする本体は、ビルド時に処理コードを丸ごと物理削除すること（build/build-trial.js 参照）。
    //     この設定を書き換えても、お試し版には処理そのものが無いので動かない。
    lockedCards: [],
    lockedNote: "この版では利用できません", // ロックしたカードの説明文の末尾に足す一言
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
    "act:visitor": {
      name: "静かなる来訪者", kana: "しずかなるらいほうしゃ",
      copy: "2点を払ってお邪魔カードを1回防ぐ",
    },
  };
  const isAction = (id) => typeof id === "string" && id.startsWith("act:");

  // デッキ編集で選んだ枚数（スタート画面で調整）。herbs は { 生薬id: 枚数 }
  let deckPrefs = { harvest: CONFIG.harvestCardCopies, daishukaku: CONFIG.bigHarvestCardCopies, herbs: {} };
  const ROUNDS_MIN = 3;                       // お題数の下限（±で選べる範囲。上限は CONFIG.maxRounds＝10）
  const ROUNDS_DEFAULT = 5;                   // お題数の既定（少なめ＝方剤を組みやすい。プレイヤーは±で変更可）
  let selectedRounds = ROUNDS_DEFAULT;        // 1ゲームのお題数（実際はテーマの症状数で頭打ち）
  // スタート画面で選んだモード： "solo"（自習・1人）／ "cpu"（CPUと対戦）／ "vs"（同じ端末で2人交代）
  let selectedMode = "solo";
  // CPU対戦の強さ： "easy"（やさしい・お邪魔しない）／ "normal"（ふつう・ときどきお邪魔）／ "hard"（つよい・積極的にお邪魔＋防御）
  let selectedCpuLevel = "normal";
  const cpuLevelNote = (l) =>
    l === "easy" ? "お邪魔してきません。自分の方剤を組むことに専念します（やさしい）。"
    : l === "hard" ? "積極的にお邪魔カードを使い、来訪者で守ってきます（手強い）。"
    : "ときどきお邪魔カードを使ってきます（ふつう）。";
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
    // 選んだトークンは「テーマid」でも「サブグループid」でもよい。どちらかに一致した方剤を集める。
    const activeFormulas = formulas.filter(f => set.has(f.theme) || (f.subgroup && set.has(f.subgroup)));
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
      totalRounds: Math.min(sel.activeSymptoms.length, selectedRounds),
      round: 0,            // 何ラウンド目か（1始まり表示・共有）
      currentSymptom: null,
      hintOpen: false,
      finished: false,
      nextUid: 1,          // uidは全体で一意（盤をまたいでも衝突しない）
      // --- アクティブ盤（ソロ＝唯一の盤／対戦＝手番プレイヤーの盤）---
      deck: [], discard: [], hand: [], shelf: [],
      pot: { hand: [], bottles: [] },
      roundTurn: 1, drewThisTurn: false, score: 0, log: [],
      justDrawn: [], usedActions: [], roundOf: 0, guard: 0,
      // --- 対戦メタ ---
      active: 0,
      cpuLevel: selectedCpuLevel, // CPU対戦のときの強さ（他モードでは未使用）
      players: null,       // 対戦：[盤スナップショット0, 盤スナップショット1]
      playerNames: isVs
        ? [(vsSetup && vsSetup[0].name) || "プレイヤー1", (vsSetup && vsSetup[1].name) || "プレイヤー2"]
        : null,
    };
    if (isVs) {
      // 各自の編集デッキで盤を作る（vsSetup が無ければ既定 deckPrefs）
      const prefs0 = vsSetup ? vsSetup[0].prefs : null;
      const prefs1 = vsSetup ? vsSetup[1].prefs : null;
      state.players = [makeBoard(sel, prefs0, vsSetup && vsSetup[0].isCpu), makeBoard(sel, prefs1, vsSetup && vsSetup[1].isCpu)];
      nextRound();     // round=1・お題セット（対戦はここでは引かない）
      beginTurn(0);    // 先手＝プレイヤー1が初手を引く
    } else {
      // 自習（ソロ）は相手がいないので、お邪魔・来訪者は絶対に入れない（deckPrefs に残っていても 0 で上書き）
      const soloPrefs = Object.assign({}, deckPrefs, { jama: 0, visitor: 0 });
      state.deck = shuffle(buildDeck(sel.herbIds, soloPrefs));
      nextRound();     // round=1・お題セット・手札を初手6枚まで補充
    }
    render();
  }

  // ---- 対戦：盤（プレイヤーの持ち物）を入れ替える仕組み ----------------
  // アクティブ盤は state の下記フィールドに入る。手番交代で退避／復元する。
  const BOARD_FIELDS = ["deck", "discard", "hand", "shelf", "roundTurn", "drewThisTurn", "score", "log", "usedActions", "roundOf", "guard"];
  function makeBoard(sel, prefs, isCpu) {
    return {
      deck: shuffle(buildDeck(sel.herbIds, prefs)),
      discard: [], hand: [], shelf: [],
      roundTurn: 1, drewThisTurn: false, score: 0, log: [], usedActions: [], roundOf: 0, guard: 0,
      isCpu: !!isCpu,   // このプレイヤーはコンピュータか（対CPU戦で使用）
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
    let dealt = [];
    if (state.roundOf !== state.round) { // このお題に初めて着手＝初手番。まず開幕を配る
      state.roundOf = state.round;
      state.roundTurn = 1;
      dealt = drawTo(Math.max(state.hand.length, CONFIG.handStart));
      state.justDrawn = dealt;
    }
    state.drewThisTurn = true;
    scheduleStartDraw(dealt); // 少し間を置いて手番開始の+2（決定論モードは即時）。配りの収穫も演出の対象
    // お邪魔カードで薬瓶を壊されていたら、手番開始時に「割れる演出」で知らせる
    // body 直下に出すので、この後の自動ドローの render が走っても消えない（確認を押すまで残る）
    if (state.players[i].notice && state.players[i].notice.length) {
      const names = state.players[i].notice;
      state.players[i].notice = null;
      showBottleBrokenNotice(names);
    }
  }

  // 薬瓶が破壊されたお知らせ（瓶が割れるアニメつき）
  function showBottleBrokenNotice(names) {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="broken-modal">
        <img class="broken-illust" src="jama.png" alt="招かれざる客" onerror="this.remove()">
        <div class="broken-anim"><span class="broken-bottle">🫙</span><span class="broken-burst">💥</span></div>
        <div class="broken-title">🐭 招かれざる客！</div>
        <p class="broken-text">あなたの薬瓶「${names.join("」「")}」が<b>破壊</b>され、<br>中の生薬は<b>あなたの捨て札</b>に移りました。<br><span class="broken-sub">（「大収穫」で山札に戻して立て直せます）</span></p>
        <button id="broken-ok" class="primary-btn">確認</button>
      </div>`;
    document.body.appendChild(overlay); // #app 内だと自動ドローの render で消えるので body 直下に出す（確認を押すまで残す）
    document.getElementById("broken-ok").addEventListener("click", () => overlay.remove());
  }
  // 「収穫カード」を引き当てたとき、かわいいイラストをふわっと表示（少しで自動的に消える）
  function harvestFlash(added) {
    if (!added || !added.length) return;
    if ((window.KAMPO_DECK || window.KAMPO_ACTIONS) && !window.KAMPO_FORCE_FLASH) return; // テスト（決定論）モードでは既定で出さない
    const drew = added.some((uid) => {
      const c = state.hand.find((x) => x.uid === uid);
      return c && c.id === "act:harvest";
    });
    if (!drew) return;
    const old = document.querySelector(".harvest-flash");
    if (old) old.remove();
    const el = document.createElement("div");
    el.className = "harvest-flash";
    el.innerHTML = `<div class="harvest-flash-inner">
      <img class="harvest-illust" src="harvest.png" alt="収穫" onerror="this.remove()">
      <div class="harvest-flash-cap">🌿 収穫カードを引いた！</div>
    </div>`;
    document.body.appendChild(el); // #app 内だと render で消えるので body 直下に出す
    setTimeout(() => { if (el.parentNode) el.remove(); }, 1900);
  }

  // 手番開始の自動ドロー(+2)を「少し間を置いて」実行する（配り/切替のあと引く感じを出す）。
  // 決定論モード（KAMPO_DECK/KAMPO_ACTIONS指定時）は遅延なしで即引く（テスト用）。
  let drawTimer = null;
  // dealt: お題開始の「開幕の配り」で来たカード。ここで来た収穫にも演出を出す（出さないと
  // 「お題の1枚目だけ無言」になる）。+2 とまとめて一度だけ出すので、演出は二重にならない。
  function scheduleStartDraw(dealt) {
    if (drawTimer) { clearTimeout(drawTimer); drawTimer = null; }
    const dealtUids = dealt ? dealt.slice() : [];
    const doDraw = () => {
      drawTimer = null;
      if (!state || state.finished || !state.currentSymptom) return;
      const added = drawTo(Math.min(CONFIG.handHard, state.hand.length + CONFIG.drawPerTurn));
      state.justDrawn = added;
      render(); // render の最後で state.justDrawn は空にされるので、控えの added を使う
      harvestFlash(dealtUids.concat(added)); // 配り＋今引いた2枚に収穫があればイラストをふわっと表示
      if (isCpuPlayer(state.active)) scheduleCpuTurn(); // CPUの手番なら、ドロー完了後に自動で行動
    };
    const delay = (window.KAMPO_DECK || window.KAMPO_ACTIONS) ? 0 : (CONFIG.turnDrawDelayMs || 0);
    if (delay > 0) drawTimer = setTimeout(doDraw, delay);
    else doDraw();
  }

  // 対CPU戦の判定
  const isCpuPlayer = (i) => !!(state.players && state.players[i] && state.players[i].isCpu);
  const hasCpu = () => !!(state.players && state.players.some(p => p && p.isCpu));

  // 現在の盤を退避して、next の手番を始める
  function handoffTo(next) {
    saveBoard(state.active);
    // 対CPU戦は「目隠し」不要（人間は1人）。CPUの番は「考え中」で覆って、人間が盤を触れないようにする。
    if (hasCpu()) {
      if (isCpuPlayer(next)) {
        showCpuThinking();
        beginTurn(next);   // ここで render() は呼ばない：beginTurn→ドローが描画する。
        //                    直後に render() すると、CPUが提出して出した結果モーダルを消してしまう。
      } else {
        removeCpuThinking(); // 人間の番になる瞬間にだけカバーを外す（CPUの手札を最後まで見せない）
        beginTurn(next);
        render();            // 人間の手番：すぐ盤を表示
      }
      return;
    }
    showHandoff(next);  // 2人対戦：目隠しを挟む
  }

  // CPUの番を覆うカバー（人間の誤操作防止＋CPUの手札を見せない）。
  //   外すのは「人間の手番になる瞬間(handoffTo)」か「ゲーム終了画面」だけ。
  //   CPUが提出したときは結果モーダルをこのカバーの上に重ねる＝下のCPU手札は最後まで見えない。
  function showCpuThinking() {
    if (document.getElementById("cpu-thinking")) return;
    const o = document.createElement("div");
    o.id = "cpu-thinking"; o.className = "overlay";
    o.innerHTML = `<div class="cpu-think"><div class="cpu-think-face">🤖</div><p class="cpu-think-text">CPUの番… 考えています</p></div>`;
    document.body.appendChild(o);  // body直下＝この後の自動ドローの render でも消えない
  }
  function removeCpuThinking() { const o = document.getElementById("cpu-thinking"); if (o) o.remove(); }

  // ---- CPU（コンピュータ）の頭脳 ----------------------------------
  // シミュ(sim/theme-hitrate.js)と同じ考え方：お題に得点する方剤を、手札の生薬＋棚の薬瓶から
  //   組めるなら提出。組めなければ、お題に不要な生薬・余った重複を捨てて手番を返す（パスはしない）。
  function scheduleCpuTurn() {
    const delay = (window.KAMPO_DECK || window.KAMPO_ACTIONS) ? 0 : (CONFIG.cpuThinkMs || 800);
    if (delay > 0) setTimeout(runCpuTurn, delay); else runCpuTurn();
  }

  // 方剤 f を「手札の生薬＋（部分集合の）薬瓶」でちょうど組めるか。組めれば使う手札uid・薬瓶uidを返す。
  //   useBottles=false は手札だけで試す（薬瓶を無駄に消費しないよう、まず手札だけ→だめなら薬瓶も）。
  function cpuAssemble(f, handHerbs, bottles, useBottles) {
    const need = new Set(f.herbs);
    const covered = new Set();
    const bottleUids = [];
    if (useBottles) {
      const usable = bottles.filter(b => b.herbs.every(h => need.has(h))).sort((a, b) => b.herbs.length - a.herbs.length);
      for (const b of usable) {
        if (b.herbs.some(h => covered.has(h))) continue; // 重複する薬瓶は使わない
        b.herbs.forEach(h => covered.add(h));
        bottleUids.push(b.uid);
      }
    }
    const handUids = [];
    const pool = handHerbs.slice();
    for (const h of f.herbs) {
      if (covered.has(h)) continue;
      const idx = pool.findIndex(c => c.id === h);
      if (idx < 0) return null; // 足りない生薬がある
      handUids.push(pool[idx].uid); pool.splice(idx, 1);
    }
    return { handUids, bottleUids };
  }

  // いま提出できる最良の方剤を選ぶ（お題のマッチ点が高い→味数が多い順）。無ければ null。
  // 方剤 f を「手札の生薬＋薬瓶」でちょうど組めるか（提出プラン or null）
  function cpuPlanFor(f) {
    const handHerbs = state.hand.filter(c => !isAction(c.id));
    const plan = cpuAssemble(f, handHerbs, state.shelf, false) || cpuAssemble(f, handHerbs, state.shelf, true);
    return plan ? Object.assign({ formula: f }, plan) : null;
  }

  // いま提出できる中で最良の方剤（得点が高い→味数が多い順）。無ければ null。
  function cpuBestSubmit() {
    for (const f of cpuTargetFormulas()) {
      const plan = cpuPlanFor(f);
      if (plan) return plan;
    }
    return null;
  }

  // お題に不要な生薬・余った重複を、手札上限(handSoft)まで捨てる。
  //   ※必ず手番を返せるよう、最後は補助・お邪魔カードも捨てて確実に上限以下にする（フリーズ防止）。
  function cpuDiscardExcess() {
    const sym = state.currentSymptom;
    const needed = new Set();
    if (sym) Object.keys(sym.score).filter(fid => sym.score[fid] > 0 && formulaById[fid])
      .forEach(fid => formulaById[fid].herbs.forEach(h => needed.add(h)));
    // 既に薬瓶（土台）で確保済みの生薬は、手札に重ねて持つ必要がない＝余りとして捨ててよい
    //   （これをしないと、積んだ土台の生薬コピーで手札が詰まり、大きい方剤を組めなくなる）
    for (const b of state.shelf) for (const h of b.herbs) needed.delete(h);
    let guard = 0;
    while (state.hand.length > CONFIG.handSoft && guard++ < 40) {
      const c = state.hand;
      let drop = c.find(x => !isAction(x.id) && !needed.has(x.id));   // お題に不要な生薬
      if (!drop) { const cnt = {}; c.forEach(x => { if (!isAction(x.id)) cnt[x.id] = (cnt[x.id] || 0) + 1; });
        drop = c.find(x => !isAction(x.id) && cnt[x.id] > 1); }        // 余った重複
      if (!drop) drop = c.find(x => x.id === "act:jama");             // 使えなかったお邪魔
      if (!drop) drop = c.find(x => x.id === "act:visitor");          // 使えなかった来訪者
      if (!drop) drop = c.find(x => !isAction(x.id));                 // それでも余れば生薬
      if (!drop) drop = c.find(x => isAction(x.id));                  // 最後の手段：補助カードも捨てる
      if (!drop) break;
      discardCard(drop.uid);
    }
  }

  // 強さ設定 → CPUが使う手（お邪魔の度合いで難易度が上がる）
  //   easy  ：カードを使わず、土台も積まない（手札だけで組む＝一番やさしい）
  //   normal：収穫・大収穫で整え、土台を薬瓶に積んで大きい方剤も狙い、相手が薬瓶を2つ以上ためたらお邪魔
  //   hard  ：normalに加え、相手が1つでも薬瓶を持てばお邪魔、相手がお邪魔を持てば来訪者で防御
  //   bottle：土台（部分方剤）を薬瓶に確保して、ターンをまたいで大きい方剤を組み上げるか
  //   build ：最有力（最高得点）の方剤に「あと少し」なら安売りせず組み上げにいくか（つよいのみ）
  const CPU_CLOSE = 2; // 「あと少し」の判定：最有力方剤の不足生薬がこの数以下なら組み上げにいく
  function cpuStrategy() {
    const l = (state && state.cpuLevel) || "normal";
    if (l === "easy")  return { harvest: false, bigHarvest: false, bottle: false, build: false, jama: false, visitor: false, jamaMinBottles: 99 };
    if (l === "hard")  return { harvest: true,  bigHarvest: true,  bottle: true,  build: true,  jama: true,  visitor: true,  jamaMinBottles: 1 };
    return               { harvest: true,  bigHarvest: true,  bottle: true,  build: false, jama: true,  visitor: false, jamaMinBottles: 2 };
  }

  // 方剤 f を「手札の生薬＋薬瓶」で組もうとし、足りない生薬(missing)も報告する（cpuAssembleの寛容版）。
  function cpuCover(f, handHerbs, bottles) {
    const need = new Set(f.herbs);
    const covered = new Set();
    const bottleUids = [];
    const usable = bottles.filter(b => b.herbs.every(h => need.has(h))).sort((a, b) => b.herbs.length - a.herbs.length);
    for (const b of usable) {
      if (b.herbs.some(h => covered.has(h))) continue;
      b.herbs.forEach(h => covered.add(h));
      bottleUids.push(b.uid);
    }
    const handUids = [], missing = [];
    const pool = handHerbs.slice();
    for (const h of f.herbs) {
      if (covered.has(h)) continue;
      const idx = pool.findIndex(c => c.id === h);
      if (idx < 0) { missing.push(h); continue; }
      handUids.push(pool[idx].uid); pool.splice(idx, 1);
    }
    return { handUids, bottleUids, missing };
  }

  // 方剤 f が「まだ組める見込み」か（不足生薬がすべて山札に残っているか）。
  //   つよいCPUが土台を積み続けてよいかの判定に使う。山札に無ければ＝もう完成しない→粘らない。
  function cpuFormulaReachable(f) {
    const handHerbs = state.hand.filter(c => !isAction(c.id));
    const { missing } = cpuCover(f, handHerbs, state.shelf);
    if (!missing.length) return true;
    const deckCounts = {};
    for (const id of state.deck) { if (!isAction(id)) deckCounts[id] = (deckCounts[id] || 0) + 1; }
    const need = {}; missing.forEach(h => need[h] = (need[h] || 0) + 1);
    return Object.keys(need).every(h => (deckCounts[h] || 0) >= need[h]);
  }

  // お題に得点する方剤を、得点の高い順に並べて返す
  function cpuTargetFormulas() {
    const sym = state.currentSymptom;
    if (!sym) return [];
    return Object.keys(sym.score)
      .filter(fid => sym.score[fid] > 0 && formulaById[fid])
      .map(fid => formulaById[fid])
      .sort((a, b) => (sym.score[b.id] - sym.score[a.id]) || (a.herbs.length - b.herbs.length));
  }

  // 収穫カードで、山札から生薬 wantIds を手札へ（openHarvestPickerの非対話版＝CPU用）
  function cpuHarvest(cardUid, wantIds) {
    const counts = {};
    for (const id of state.deck) { if (!isAction(id)) counts[id] = (counts[id] || 0) + 1; }
    const stock = Object.values(counts).reduce((s, n) => s + n, 0);
    const maxPick = Math.max(1, Math.min(CONFIG.harvestPick, stock));
    const picked = [];
    for (const id of wantIds) {
      if (picked.length >= maxPick) break;
      if ((counts[id] || 0) - picked.filter(p => p === id).length > 0) picked.push(id);
    }
    if (!picked.length) return false;
    picked.forEach(id => { if (removeFromDeck(id)) state.hand.push({ uid: state.nextUid++, id }); });
    state.hand = state.hand.filter(c => c.uid !== cardUid);
    state.pot.hand = state.pot.hand.filter(u => u !== cardUid);
    state.usedActions.push("act:harvest");
    flash(`🤖 CPUが収穫を使った（生薬 ${picked.length}枚）。`, "ok");
    render();
    return true;
  }

  // いま組めないとき、収穫で「あと少しで完成する方剤」の不足生薬を山札から取る。
  //   only を渡すとその方剤だけを狙う（つよいCPUが最有力方剤に集中するため）。
  function cpuTryHarvestForTarget(only) {
    const harv = state.hand.find(c => c.id === "act:harvest");
    if (!harv) return false;
    const handHerbs = state.hand.filter(c => !isAction(c.id));
    const deckCounts = {};
    for (const id of state.deck) { if (!isAction(id)) deckCounts[id] = (deckCounts[id] || 0) + 1; }
    for (const f of (only ? [only] : cpuTargetFormulas())) {
      const { missing } = cpuCover(f, handHerbs, state.shelf);
      if (missing.length === 0 || missing.length > CONFIG.harvestPick) continue;
      const need = {}; missing.forEach(h => need[h] = (need[h] || 0) + 1);
      if (Object.keys(need).every(h => (deckCounts[h] || 0) >= need[h])) {
        return cpuHarvest(harv.uid, missing);   // 山札に不足分が揃っている方剤だけ狙う
      }
    }
    return false;
  }

  // 必要な生薬が捨て札に埋もれているとき、大収穫で山札へ戻す（そのあと収穫で拾える）
  function cpuTryBigHarvest() {
    const big = state.hand.find(c => c.id === "act:daishukaku");
    if (!big || state.discard.length === 0) return false;
    const handHerbs = state.hand.filter(c => !isAction(c.id));
    const deckCounts = {}, allCounts = {};
    for (const id of state.deck) if (!isAction(id)) deckCounts[id] = (deckCounts[id] || 0) + 1;
    for (const id of state.deck.concat(state.discard)) if (!isAction(id)) allCounts[id] = (allCounts[id] || 0) + 1;
    for (const f of cpuTargetFormulas()) {
      const { missing } = cpuCover(f, handHerbs, state.shelf);
      if (missing.length === 0 || missing.length > CONFIG.harvestPick) continue;
      const need = {}; missing.forEach(h => need[h] = (need[h] || 0) + 1);
      const availNow   = Object.keys(need).every(h => (deckCounts[h] || 0) >= need[h]);
      const availAfter = Object.keys(need).every(h => (allCounts[h]  || 0) >= need[h]);
      if (!availNow && availAfter) { useBigHarvest(big.uid); return true; } // 戻せば拾える見込みがあるときだけ
    }
    return false;
  }

  // お邪魔（招かれざる客）：相手が薬瓶を規定数以上ためていたら1つ壊す
  function cpuMaybeAttack(S) {
    const j = state.hand.find(c => c.id === "act:jama");
    if (!j) return;
    const opp = 1 - state.active;
    const oppBottles = (state.players[opp].shelf || []).length;
    if (oppBottles < S.jamaMinBottles) return;
    useJama(j.uid);   // 相手の来訪者・ランダム対象・消費はすべて useJama が処理
  }

  // 生薬idの集合が同じか（薬瓶の重複判定用）
  const sameHerbSet = (a, b) => a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");
  // 手札(生薬カード)から needHerbs をちょうど1枚ずつ拾えれば、その uid 配列を返す（無ければ null）
  function cpuPickHandUids(handHerbs, needHerbs) {
    const pool = handHerbs.slice(), uids = [];
    for (const h of needHerbs) {
      const idx = pool.findIndex(c => c.id === h);
      if (idx < 0) return null;
      uids.push(pool[idx].uid); pool.splice(idx, 1);
    }
    return uids;
  }

  // 土台づくり（積み上げ方式）：提出できないとき、最有力の目標方剤の「部分方剤（土台）」を
  //   手札から薬瓶に確保する。薬瓶はお題をまたいで残るので、ターンを重ねて大きい方剤を組み上げられる。
  //   1つでも確保できたら true（呼び出し側は収穫→再提出を試す）。
  //   only を渡すとその方剤の土台だけを積む（つよいCPUが最有力方剤に集中するため）。
  function cpuMaybeBottle(only) {
    let bottled = false;
    for (const T of (only ? [only] : cpuTargetFormulas())) {
      // T の部分方剤（既知・T の生薬に完全に含まれる・T より小さい）を大きい順に
      const subs = formulas
        .filter(f => f.id !== T.id && f.herbs.length < T.herbs.length && f.herbs.every(h => T.herbs.includes(h)))
        .sort((a, b) => b.herbs.length - a.herbs.length);
      if (!subs.length) continue;
      let progressed = true;
      while (progressed) {
        progressed = false;
        // すでに棚にある（Tに使える）薬瓶が覆っている生薬は、二重に土台を作らない
        const covered = new Set(
          state.shelf.filter(b => b.herbs.every(h => T.herbs.includes(h))).flatMap(b => b.herbs)
        );
        const handHerbs = state.hand.filter(c => !isAction(c.id));
        for (const sub of subs) {
          if (state.shelf.some(b => sameHerbSet(b.herbs, sub.herbs))) continue; // 同じ薬瓶は作らない
          if (sub.herbs.some(h => covered.has(h))) continue;                     // 既存土台と重複は避ける
          const uids = cpuPickHandUids(handHerbs, sub.herbs);
          if (!uids) continue;                                                   // 手札に土台がそろわない
          state.pot = { hand: uids, bottles: [] };
          if (!potFormula()) { state.pot = { hand: [], bottles: [] }; continue; } // 念のため：既知方剤でなければやめる
          bottlePot();                                                           // 消費→棚へ確保（render/flash）
          bottled = true; progressed = true;
          break;                                                                 // 手札が変わったので作り直す
        }
      }
      if (bottled) break;   // 最有力の目標に向けて積んだら十分（別の目標は次の手番で）
    }
    state.pot = { hand: [], bottles: [] };
    return bottled;
  }


  function runCpuTurn() {
    if (!state || state.finished || !state.currentSymptom || !isCpuPlayer(state.active)) { removeCpuThinking(); return; }
    const S = cpuStrategy();
    // 盤は「考え中」カバーで覆ったまま考える（CPUの手札を人間に見せない）。
    if (S.jama)    cpuMaybeAttack(S); // お邪魔（ふつう・つよい）
    let plan = null;

    // つよい：賢く判断する。最有力（最高得点）の方剤に「あと少し」なら、小さな安売りをせず組み上げる。
    if (S.build) {
      const top = cpuTargetFormulas()[0];
      if (top) {
        plan = cpuPlanFor(top);                                                    // 最有力を今そのまま組めるか
        if (!plan && S.harvest && cpuTryHarvestForTarget(top)) plan = cpuPlanFor(top); // 収穫で今完成できるか
        if (!plan) {
          // 最有力は今は組めない。不足が CPU_CLOSE 以下＝「あと少し」で、必要な生薬が山札に残っているなら、
          //   小さな部分一致で安売りせず、土台を薬瓶に確保しつつ引いて、次の手番で組み切りにいく。
          const handHerbs = state.hand.filter(c => !isAction(c.id));
          const missing = cpuCover(top, handHerbs, state.shelf).missing;
          if (missing.length && missing.length <= CPU_CLOSE && cpuFormulaReachable(top)) {
            if (S.bottle) cpuMaybeBottle(top);   // 手札の土台を薬瓶に確保して手を軽くする
            cpuDiscardExcess(); endTurn(); return;
          }
          // 遠い（あと少しではない）→ 下で作れる中の最善（部分一致でも）を出して点を取る
        }
      }
    }

    // ふつう・やさしい、または つよいが最有力に前進できなかったとき：作れる中で最善を提出
    if (!plan) {
      plan = cpuBestSubmit();
      if (!plan && S.harvest && cpuTryHarvestForTarget()) plan = cpuBestSubmit();     // 収穫で不足を補って再挑戦
      if (!plan && S.bigHarvest && cpuTryBigHarvest()) {                              // 大収穫で立て直し→収穫→再挑戦
        if (S.harvest) cpuTryHarvestForTarget();
        plan = cpuBestSubmit();
      }
      if (!plan && S.bottle && cpuMaybeBottle()) {                                    // 土台を薬瓶に積んで大きい方剤を狙う
        if (S.harvest) cpuTryHarvestForTarget();                                      // 積んだ後の残りを収穫で補い
        plan = cpuBestSubmit();                                                       // 揃えば同じ手番で提出
      }
    }
    // カバーはここでは外さない（外すと一瞬CPUの手札が見える）。
    //   提出時：結果モーダルをカバーの上に重ねる。手番を返す時：handoffTo が人間の番でカバーを外す。
    if (plan) {
      state.pot = { hand: plan.handUids.slice(), bottles: plan.bottleUids.slice() };
      submitPot();        // 得点確定→結果モーダル（カバーの上）→（次へで）人間の手番へ
      return;
    }
    cpuDiscardExcess();
    endTurn();            // 提出できないので手番を人間へ返す（handoffTo でカバーが外れる）
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
    // おまかせは「お題数スライダー」に左右されず、最大お題数(10)でも足りる枚数を常に確保する。
    // （デッキはデッキ／お題数は消耗の度合いを変えるだけ、という分かりやすいモデルにする）
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
    const aux = deckPrefs.harvest + deckPrefs.daishukaku + (deckPrefs.jama || 0) + (deckPrefs.visitor || 0);
    el.textContent = `デッキ合計 ${herbTotal + aux} 枚（生薬 ${herbTotal} ＋ 補助・お邪魔 ${aux}）`;
  }

  // この版で使えないカードか（お試し版など）。ロック時は 0枚固定＝デッキに入れられない
  const isLocked = (card) => (CONFIG.lockedCards || []).includes(card);
  // ロックされたカードの説明文の末尾に足す注記（例：「／お試し版では利用できません」）
  const lockedSuffix = (card) => isLocked(card) ? `<span class="de-locked-note">（${CONFIG.lockedNote}）</span>` : "";

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
          <div class="deck-editor-row${isLocked("visitor") ? " de-locked" : ""}">
            <span class="de-name"><span class="de-titleline">🐈 静かなる来訪者<span class="de-max">（${isLocked("visitor") ? "対戦専用" : `対戦専用・最大${CONFIG.deckCardMax}枚`}）</span></span><span class="de-desc">${CONFIG.visitorCost}点を払ってお邪魔カードを1回防ぐ${lockedSuffix("visitor")}</span></span>
            <span class="de-stepper">
              <button type="button" class="de-step" data-card="visitor" data-delta="-1"${isLocked("visitor") ? " disabled" : ""}>−</button>
              <b id="de-visitor">${isLocked("visitor") ? 0 : (deckPrefs.visitor || 0)}</b>
              <button type="button" class="de-step" data-card="visitor" data-delta="1"${isLocked("visitor") ? " disabled" : ""}>＋</button>
            </span>
          </div>` : ""}

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
      if (isLocked(card)) return; // この版で使えないカードは増減させない（0枚固定）
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
    // CPU対戦では、あなたも「招かれざる客／来訪者」を使える。デッキ編集に出すため既定枚数を用意（未設定なら）。
    if (selectedMode === "cpu") {
      if (!Number.isFinite(deckPrefs.jama)) deckPrefs.jama = CONFIG.jamaCardCopies;
    }
    app.innerHTML = `
      <div class="start-screen">
        <h1>学んで効く！<span>漢方カードバトル</span>${CONFIG.editionLabel ? `<span class="edition-badge">${CONFIG.editionLabel}</span>` : ""}</h1>
        <div class="title-btns">
          <button type="button" id="intro-btn" class="ghost-btn intro-btn">🎬 遊び方の解説動画</button>
          <button type="button" id="zukan-btn" class="ghost-btn zukan-btn">📖 収録図鑑（生薬・方剤の一覧）</button>
        </div>
        <div class="mode-select">
          <button type="button" class="mode-btn ${selectedMode !== "vs" ? "selected" : ""}" data-mode="solo">🧑 ソロ（1人）</button>
          <button type="button" class="mode-btn ${selectedMode === "vs" ? "selected" : ""}" data-mode="vs">🧑‍🤝‍🧑 2人対戦</button>
        </div>
        ${selectedMode !== "vs" ? `
        <div class="submode-tabs">
          <button type="button" class="submode-tab ${selectedMode === "solo" ? "selected" : ""}" data-submode="solo">📖 自習（相手なし）</button>
          <button type="button" class="submode-tab ${selectedMode === "cpu" ? "selected" : ""}" data-submode="cpu">🤖 CPUと対戦</button>
        </div>` : ""}
        <p class="mode-note">${selectedMode === "vs"
          ? "同じ端末を交代で使います（目隠し→交代）。同じお題を先に解いた方が高得点。"
          : selectedMode === "cpu"
          ? "コンピュータと1人で対戦。同じお題を先に正しく解いた方が高得点。あなたのデッキを編集して挑戦。"
          : "1人でじっくり自習。相手なしで、テーマの症状を解いて診療結果をめざします。"}</p>
        ${selectedMode === "cpu" ? `
        <div class="cpu-level" role="group" aria-label="CPUの強さ">
          <span class="cpu-level-title">CPUの強さ</span>
          <div class="cpu-level-btns">
            <button type="button" class="cpu-level-btn ${selectedCpuLevel === "easy" ? "selected" : ""}" data-level="easy">やさしい</button>
            <button type="button" class="cpu-level-btn ${selectedCpuLevel === "normal" ? "selected" : ""}" data-level="normal">ふつう</button>
            <button type="button" class="cpu-level-btn ${selectedCpuLevel === "hard" ? "selected" : ""}" data-level="hard">つよい</button>
          </div>
          <p class="cpu-level-note">${cpuLevelNote(selectedCpuLevel)}</p>
        </div>` : ""}
        <p class="start-lead">今回あそぶ<b>テーマ</b>を選んでください。選んだテーマの症状だけが出て、
          デッキもそのテーマに必要な生薬だけで組まれます。<br>
          テーマを多く選ぶほどデッキが薄まり、<b>難しく</b>なります。</p>
        <div class="theme-list">
          ${themes.map(t => {
            const n = formulas.filter(f => f.theme === t.id).length;
            const subs = subgroups.filter(b => b.theme === t.id);   // このテーマのサブグループ
            const subLabel = t.subLabel || "分類";                   // 軸の呼び名（かぜ=病位／安神=証）
            return `
              <label class="theme-item">
                <input type="checkbox" class="theme-check" value="${t.id}" ${selectedThemes.includes(t.id) ? "checked" : ""}>
                <span class="theme-body">
                  <span class="theme-name">${t.name} <span class="theme-count">${n}方剤</span></span>
                  <span class="theme-desc">${t.desc}</span>
                </span>
                <button type="button" class="detail-btn" data-detail="${t.id}">詳細</button>
              </label>
              ${subs.length ? `<div class="subgroup-list">
                <p class="subgroup-lead">▸ ${subLabel}でしぼる（1つだけ選ぶとデッキが小さく＝方剤を組みやすい。上の「${t.name.replace(/（.*/, "")}」を選べば全部）</p>
                ${subs.map(b => {
                  const bn = formulas.filter(f => f.subgroup === b.id).length;
                  return `
                    <label class="theme-item subgroup-item">
                      <input type="checkbox" class="theme-check" value="${b.id}" ${selectedThemes.includes(b.id) ? "checked" : ""}>
                      <span class="theme-body">
                        <span class="theme-name">${b.name} <span class="theme-count">${bn}方剤</span></span>
                        <span class="theme-desc">${b.desc}</span>
                      </span>
                      <button type="button" class="detail-btn" data-detail="${b.id}">詳細</button>
                    </label>`;
                }).join("")}
              </div>` : ""}`;
          }).join("")}
        </div>
        <div class="rounds-editor">
          <span class="rounds-name"><span class="rounds-title">🎯 お題の数</span><span class="rounds-desc">少ないほど方剤を組みやすく、増やすと手応えアップ（最大10）。</span></span>
          <span class="de-stepper">
            <button type="button" class="rounds-step" data-delta="-1">−</button>
            <b id="rounds-val">${selectedRounds}</b>
            <button type="button" class="rounds-step" data-delta="1">＋</button>
          </span>
        </div>
        ${selectedMode !== "vs" ? deckEditorHTML(selectedMode === "cpu") : `
        <p class="vs-setup-hint">対戦では、このあと<b>各プレイヤーが自分の名前とデッキ</b>を設定します（相手には見えません）。</p>`}
        <p class="start-note" id="start-note"></p>
        <button id="start-btn" class="primary-btn">${selectedMode === "vs" ? "プレイヤーの準備へ →" : "この内容であそぶ"}</button>
        ${CONFIG.requireConsent ? "" : `<p class="disclaimer">⚠ 本アプリは漢方を楽しく学ぶための教育・娯楽目的の試作です。医療上の診断・治療・処方の助言ではありません。体調不良は医師・薬剤師にご相談ください。生薬の性質・方剤の効能などの記載は学習用のたたき台で、監修中の内容を含みます。</p>`}
      </div>
      <div id="toast" class="toast hidden"></div>
    `;

    // お題数・生薬種類の案内文だけを更新（デッキ編集はいじらない）。テーマ変更とお題数変更の両方から呼ぶ。
    const updateStartNote = () => {
      const ids = getCheckedThemes();
      const note = $("#start-note");
      const btn = $("#start-btn");
      if (!note) return;
      if (ids.length === 0) {
        note.textContent = "テーマを1つ以上選んでください。";
        if (btn) btn.disabled = true;
        return;
      }
      const sel = themeSelection(ids);
      const rounds = Math.min(sel.activeSymptoms.length, selectedRounds);
      note.textContent = `お題 ${rounds} 問／デッキに入る生薬 ${sel.herbIds.length} 種（全${herbs.length}種中）`;
      if (btn) btn.disabled = false;
    };

    const refresh = () => {
      selectedThemes = getCheckedThemes();   // 選択テーマを保持（モード切替の再描画で復元）
      updateStartNote();
      // テーマが変わったら「おまかせ（最低保証）」を既定でロード（手動編集はリセット）
      if (selectedThemes.length > 0) deckPrefs.herbs = guaranteeCounts(selectedThemes);
      renderDeckEditor();
    };

    app.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => {
      selectedThemes = getCheckedThemes();          // 選択テーマを保持
      // 上段は「ソロ（1人）」か「2人対戦」。ソロを押したときは、直前が2人なら自習を既定に、
      // すでにソロ側(自習/CPU)ならその選択を保つ。
      if (b.dataset.mode === "vs") selectedMode = "vs";
      else if (selectedMode === "vs") selectedMode = "solo";
      showStartScreen();                            // 再描画
    }));
    // ソロ内のタブ（自習／CPUと対戦）
    app.querySelectorAll(".submode-tab").forEach(b => b.addEventListener("click", () => {
      selectedThemes = getCheckedThemes();
      selectedMode = b.dataset.submode;             // "solo"(自習) か "cpu"
      showStartScreen();
    }));
    // CPUの強さ（やさしい／ふつう／つよい）。デッキ編集を消さないよう、選択表示だけ更新する。
    app.querySelectorAll(".cpu-level-btn").forEach(b => b.addEventListener("click", () => {
      selectedCpuLevel = b.dataset.level;
      app.querySelectorAll(".cpu-level-btn").forEach(x => x.classList.toggle("selected", x.dataset.level === selectedCpuLevel));
      const note = app.querySelector(".cpu-level-note");
      if (note) note.textContent = cpuLevelNote(selectedCpuLevel);
    }));
    const zukanBtn = $("#zukan-btn");
    if (zukanBtn) zukanBtn.addEventListener("click", openZukan);
    const introBtn = $("#intro-btn");
    if (introBtn) introBtn.addEventListener("click", openIntroVideo);
    app.querySelectorAll(".rounds-step").forEach(b => b.addEventListener("click", () => {
      const next = selectedRounds + Number(b.dataset.delta);
      selectedRounds = Math.max(ROUNDS_MIN, Math.min(CONFIG.maxRounds, next));
      const el = $("#rounds-val"); if (el) el.textContent = selectedRounds;
      updateStartNote();   // お題数表示だけ更新（デッキは触らない）
    }));
    app.querySelectorAll(".theme-check").forEach(el => el.addEventListener("change", refresh));
    app.querySelectorAll("[data-detail]").forEach(b => b.addEventListener("click", (e) => {
      e.preventDefault();   // ラベル内のボタンなのでチェックのトグルを止める
      e.stopPropagation();
      openThemeDetail(b.dataset.detail);
    }));
    if (selectedMode !== "vs") wireDeckEditor(app);   // ソロ・CPU対戦のデッキ編集を配線
    $("#start-btn").addEventListener("click", () => {
      const ids = getCheckedThemes();
      if (ids.length === 0) return;
      selectedThemes = ids;
      if (selectedMode === "vs") startVsSetup(ids);     // 2人対戦：各自の準備画面へ
      else if (selectedMode === "cpu") {                // CPU対戦：あなた＝P1、CPU＝P2（おまかせデッキ）
        // CPUのお邪魔・来訪者は強さで変える：やさしい＝持たない／ふつう＝お邪魔のみ／つよい＝お邪魔＋来訪者
        const aggressive = selectedCpuLevel !== "easy";
        const cpuPrefs = {
          herbs: guaranteeCounts(ids),
          harvest: CONFIG.harvestCardCopies, daishukaku: CONFIG.bigHarvestCardCopies,
          jama: aggressive ? CONFIG.jamaCardCopies : 0,
        };
        newGame(ids, "vs", [
          { name: "あなた", prefs: deckPrefs, isCpu: false },
          { name: "CPU",   prefs: cpuPrefs,  isCpu: true },
        ]);
      }
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
    jama: CONFIG.jamaCardCopies,
    herbs: guaranteeCounts(themeIds),
  });
  // クローン（各プレイヤーのデッキ編集を独立保存するため）
  const clonePrefs = (p) => ({ harvest: p.harvest, daishukaku: p.daishukaku, jama: p.jama || 0, visitor: p.visitor || 0, herbs: { ...p.herbs } });

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

  // 遊び方の解説動画をYouTube埋め込みでポップアップ再生。
  //   動画自体はYouTube側（限定公開）にあるので、リポジトリは重くならない。
  //   ⚠ 埋め込みURLはリンクを含むため、build-trial.js の (C)自動ガードの
  //     allow（例外）に youtube 系ドメインを登録している（未登録だと公開ビルドが止まる）。
  const INTRO_VIDEO_ID = "mMnYQ9sKwI8"; // 遊び方・解説動画（youtube-nocookie 埋め込み）
  function openIntroVideo() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="detail-modal intro-modal">
        <div class="detail-title">🎬 遊び方の解説動画<span>ルールと進め方</span></div>
        <div class="intro-video">
          <iframe src="https://www.youtube-nocookie.com/embed/${INTRO_VIDEO_ID}?rel=0"
            title="遊び方の解説動画" allowfullscreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"></iframe>
        </div>
        <button type="button" class="primary-btn detail-close">閉じる</button>
      </div>`;
    $("#app").appendChild(overlay);
    const close = () => overlay.remove(); // iframe ごと消す＝再生も止まる
    overlay.querySelector(".detail-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

  // テーマの「詳細」：そのテーマの方剤一覧（構成生薬つき）をモーダル表示
  // 収録図鑑：いま window.KAMPO に入っている生薬・方剤をすべて一覧する。
  //   お試し版では KAMPO 自体が絞り込まれているので、自動的に収録分だけが並ぶ（漏れない）。
  function openZukan() {
    const themeShortOf = id => ((themes.find(t => t.id === id) || {}).name || id).replace(/（.*/, "");
    const subNameOf  = id => (subgroups.find(b => b.id === id) || {}).name || "";
    const asked = new Set(symptoms.map(primaryFormulaId));   // お題として問われる方剤

    // 並び替え用の比較関数
    const kanaCmp = (a, b) => a.kana.localeCompare(b.kana, "ja");   // あいうえお順（読み仮名）
    const noCmp = (a, b) => {                                        // 番号順（ツムラ番号。番号なしは末尾）
      if (a.no == null && b.no == null) return kanaCmp(a, b);
      if (a.no == null) return 1;
      if (b.no == null) return -1;
      return a.no - b.no;
    };

    // 方剤カード（テーマの小ラベル・番号・病位つき）
    const formulaCard = f => `
      <div class="detail-formula">
        <div class="detail-fhead">
          <span class="detail-fname">${f.name}<span class="detail-fkana">${f.kana}</span></span>
          <span class="detail-tag ${asked.has(f.id) ? "tag-asked" : "tag-base"}">${asked.has(f.id) ? "出題" : "土台"}</span>
        </div>
        <div class="zk-fmeta">${f.no ? `<span class="zk-no">${f.no}番</span>` : ""}<span class="zk-theme">${themeShortOf(f.theme)}</span>${f.subgroup && subNameOf(f.subgroup) ? `<span class="zk-subgroup">${subNameOf(f.subgroup)}</span>` : ""}</div>
        <div class="detail-herbs">${f.herbs.map(id => herbById[id].name).join("・")}<span class="detail-count">（${f.herbs.length}味）</span></div>
        ${f.note ? `<div class="zk-note">${f.note}</div>` : ""}
      </div>`;
    const renderFormulas = mode =>
      formulas.slice().sort(mode === "no" ? noCmp : kanaCmp).map(formulaCard).join("");

    // 生薬：あいうえお順のカードグリッド（寒熱で色分け）
    const herbCard = h => `
      <div class="zk-herb ${netsuClass[h.netsu]}">
        <div class="zk-hhead"><span class="zk-hname">${h.name}</span><span class="zk-hkana">${h.kana}</span></div>
        <div class="zk-hmeta"><span class="zk-netsu">${h.netsu}</span><span class="zk-kbs">${h.kbs.join("・")}</span></div>
        <div class="zk-hcopy">${h.copy}</div>
      </div>`;
    const herbSection = herbs.slice().sort(kanaCmp).map(herbCard).join("");

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.innerHTML = `
      <div class="detail-modal zukan-modal">
        <div class="detail-title">📖 収録図鑑<span>方剤 ${formulas.length}／生薬 ${herbs.length}</span></div>
        <p class="detail-lead">いまこのゲームに入っている方剤・生薬の一覧です。「出題」＝お題として問われる方剤／「土台」＝積み上げに使う方剤。寒熱は 温=赤・寒=青・平=黄。</p>
        <div class="zk-tabs">
          <button type="button" class="zk-tab selected" data-tab="formula">方剤 ${formulas.length}</button>
          <button type="button" class="zk-tab" data-tab="herb">生薬 ${herbs.length}</button>
        </div>
        <div class="zk-panel" data-panel="formula">
          <div class="zk-sort">
            <span class="zk-sort-label">並び順</span>
            <button type="button" class="zk-sort-btn selected" data-sort="kana">あいうえお順</button>
            <button type="button" class="zk-sort-btn" data-sort="no">番号順</button>
          </div>
          <div class="detail-list" id="zk-formula-list">${renderFormulas("kana")}</div>
        </div>
        <div class="zk-panel zk-hidden" data-panel="herb">
          <div class="zk-herb-grid">${herbSection}</div>
        </div>
        <button type="button" class="primary-btn detail-close">閉じる</button>
      </div>`;
    $("#app").appendChild(overlay);
    overlay.querySelectorAll(".zk-tab").forEach(tab => tab.addEventListener("click", () => {
      overlay.querySelectorAll(".zk-tab").forEach(x => x.classList.toggle("selected", x === tab));
      overlay.querySelectorAll(".zk-panel").forEach(p => p.classList.toggle("zk-hidden", p.dataset.panel !== tab.dataset.tab));
    }));
    overlay.querySelectorAll(".zk-sort-btn").forEach(btn => btn.addEventListener("click", () => {
      overlay.querySelectorAll(".zk-sort-btn").forEach(x => x.classList.toggle("selected", x === btn));
      overlay.querySelector("#zk-formula-list").innerHTML = renderFormulas(btn.dataset.sort);
    }));
    overlay.querySelector(".detail-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  function openThemeDetail(themeId) {
    const theme = themes.find(t => t.id === themeId) || subgroups.find(b => b.id === themeId);
    if (!theme) return;
    // themeId はテーマid（そのテーマ全方剤）でも病位id（その病位の方剤）でもよい
    const inGroup = f => f.theme === themeId || f.subgroup === themeId;
    // このグループで「お題として問われる」方剤id（症状の正解がこのグループの方剤）
    const asked = new Set(
      symptoms.map(primaryFormulaId)
        .filter(id => formulaById[id] && inGroup(formulaById[id]))
    );
    // 味数の少ない順（土台→大きな方剤へ育つ流れが見える）
    const list = formulas
      .filter(inGroup)
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
    const dealt = drawTo(Math.max(state.hand.length, CONFIG.handStart));
    state.justDrawn = dealt;
    scheduleStartDraw(dealt); // 配りで来た収穫も演出の対象にする
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
        if (state.finished) { removeCpuThinking(); saveBoard(winner); render(); return; } // 終了画面ではカバーを外す
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
    const kind = card.id === "act:daishukaku" ? "action-big"
      : card.id === "act:jama" ? "action-jama"
      : "action-harvest";
    const anim = drawIndex != null ? ` just-drawn" style="--dd:${drawIndex * 110}ms` : "";
    const badge = card.id === "act:jama" ? "お邪魔カード" : "補助カード";
    return `
      <div class="herb-card action-card ${kind}${anim}" data-uid="${card.uid}">
        <div class="herb-top"><span class="action-badge">${badge}</span></div>
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

    // 手札は折り返し表示なので横スクロールの右寄せは不要（削除済み）
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
