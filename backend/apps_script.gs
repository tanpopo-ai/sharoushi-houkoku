/**
 * ジョブカン勤怠データ → イントラサイト連携用 Web API (Google Apps Script)
 *
 * デプロイ手順:
 *   1. https://script.google.com/ を開く (s-fujikado@tanpopo-dc.com でログイン)
 *   2. 「新しいプロジェクト」→ このファイルの中身を全部貼り付け
 *   3. プロジェクト名を「ジョブカン勤怠API」などに変更
 *   4. 「デプロイ」→「新しいデプロイ」
 *      - 種類: ウェブアプリ
 *      - 説明: 任意
 *      - 次のユーザーとして実行: 自分(s-fujikado@tanpopo-dc.com)
 *      - アクセスできるユーザー: 「tanpopo-dc.com のユーザー」(Workspace内のみ)
 *           ※ 全公開にするなら「全員」(セキュリティ要検討)
 *   5. デプロイ後、ウェブアプリURL (https://script.google.com/macros/s/XXX/exec) をメモ
 *   6. イントラの JavaScript の APPS_SCRIPT_URL に貼り付け
 *
 * エンドポイント例 (デプロイURLに ?action=... を付ける):
 *   ?action=summary
 *      → 全スタッフの月別残業/特出/累積 を返す
 *      返却: { months: [...], staff: [{ name, monthlyOver, monthlySpec, cumulativeOver, cumulativeSpec }, ...] }
 *
 *   ?action=staff_list
 *      → スタッフタブ一覧 を返す
 *      返却: { staff: ["廣海 愛美 (66)", "藤門 翔平 (208)", ...] }
 *
 *   ?action=staff_detail&name=廣海 愛美 (66)
 *      → 特定スタッフの全行(ヘッダ+データ) を返す
 *      返却: { name, header: [...], rows: [[...], [...], ...] }
 */

// ★ ここを 自分のスプレッドシートID に変更 ★
const SHEET_ID = "1u5_a39MXF4SkbMH0sp9lsVLCJH67aSvE-8J_wQ3RSY8";

// 休暇申請・託児時間報告フォームの回答スプレッドシートID
// (イントラの 託児/休暇 データはここから取得。ブラウザ直fetchはCORSで不可のため
//  この Apps Script 経由で返すことでCORSを回避する)
const FORM_SHEET_ID = "1oQuCoAES6X7e2b0rOURLDUiYVHeAwZ-ybVcn7vH1Wvc";

// 残業/特出の閾値 (秒)。3時間以上なら特出。
const SPECIAL_THRESHOLD_SECONDS = 3 * 3600;

// マスター/集計タブ名 (スタッフ一覧から除外)
// フォーム回答タブ・ふりがなタブなど、スタッフでないタブもここに追加する。
const EXCLUDED_TABS = [
  "勤務データログ", "出勤簿ログ", "集計", "シート1", "Sheet1",
  "ふりがな", "休暇申請フォーム", "フォームの回答 1", "フォームの回答1",
];


function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "summary";
  let result;
  try {
    switch (action) {
      case "summary":
        result = getSummary();
        break;
      case "staff_list":
        result = getStaffList();
        break;
      case "staff_detail":
        result = getStaffDetail(e.parameter.name || "");
        break;
      case "formdata":
        result = getFormData();
        break;
      case "carerules":
        result = getCareRules();
        break;
      case "set_carerules":
        result = setCareRules(e.parameter.payload || "");
        break;
      case "ping":
        result = { ok: true, time: new Date().toISOString() };
        break;
      default:
        throw new Error("Unknown action: " + action);
    }
  } catch (err) {
    result = { error: String(err && err.message || err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ============================================================
 * 託児の計算ルール（全端末で共有）
 *   ScriptProperties に JSON で保存。イントラの「託児時間 月次集計」タブ
 *   から取得(carerules)・更新(set_carerules)される。
 *   数値のみのホワイトリストでバリデーションしてから保存する。
 * ============================================================ */
const CARE_RULES_PROP_KEY = "careRules";
const CARE_RULES_ALLOWED = [
  "cutoffStart", "afternoonThreshold", "deductHours",
  "roundUnitMin", "ratePerHour", "monthlyCap", "satShiftMin"
];

function getCareRules() {
  const raw = PropertiesService.getScriptProperties().getProperty(CARE_RULES_PROP_KEY);
  let rules = null;
  if (raw) {
    try { rules = JSON.parse(raw); } catch (e) { rules = null; }
  }
  return { rules: rules };   // 未設定なら rules:null → フロントは既定値を使う
}

function setCareRules(payload) {
  if (!payload) throw new Error("payload がありません");
  const obj = JSON.parse(payload);   // 不正JSONはここで例外
  const clean = {};
  CARE_RULES_ALLOWED.forEach(function (k) {
    const v = Number(obj[k]);
    if (isFinite(v) && v >= 0) clean[k] = v;
  });
  if (Object.keys(clean).length === 0) throw new Error("有効な数値がありません");
  PropertiesService.getScriptProperties()
    .setProperty(CARE_RULES_PROP_KEY, JSON.stringify(clean));
  return { ok: true, rules: clean };
}


/**
 * 出勤簿ログから全スタッフの月別集計を返す。
 * 重複取得日時は最新スナップショットのみ採用。
 */
function getSummary() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ss.getSheetByName("出勤簿ログ");
  if (!ws) throw new Error("'出勤簿ログ' タブが見つかりません");

  // 表示文字列で取得する。これにより Date オブジェクトを文字列のまま扱える。
  // 取得日時: "2026-05-24 16:12:58" / 日付: "05/01(金)" / 実残業: "0:28" 等
  const data = ws.getDataRange().getDisplayValues();
  if (data.length < 2) {
    return { months: [], staff: [] };
  }

  const header = data[0].map(h => String(h || ""));
  const rows = data.slice(1);

  const idxAcq = header.findIndex(h => /取得日時/.test(h));
  const idxStaff = header.findIndex(h => /スタッフ/.test(h));
  const idxDate = header.findIndex(h => /日付/.test(h));
  const idxActual = header.findIndex(h => /実残業/.test(h));
  const idxIn = header.findIndex(h => /出勤/.test(h) && /時刻/.test(h)); // 出勤時刻(>0なら出勤)
  if ([idxAcq, idxStaff, idxDate, idxActual].some(i => i < 0)) {
    throw new Error("ヘッダから必要列が見つかりません: " + JSON.stringify(header));
  }

  // (staff, date) → 最新スナップショット
  const latest = {};
  for (const row of rows) {
    const staff = String(row[idxStaff] || "").trim();
    const dateStr = String(row[idxDate] || "").trim();
    if (!staff || !dateStr || dateStr.indexOf("合計") >= 0) continue;
    const acq = String(row[idxAcq] || "");
    const key = staff + "||" + dateStr;
    if (!latest[key] || String(latest[key][idxAcq]) < acq) {
      latest[key] = row;
    }
  }

  // (staff, year-month) → {over, spec}
  const monthly = {};
  // (staff, year-month) → { sat:{日:出勤bool}, sun:{日:出勤bool} } 土日出勤判定用
  const weekend = {};
  // (staff, year-month) → { worked:[7], occ:[7] } 曜日別(月0..日6) 出勤回数/該当日数
  const wdstat = {};
  const WD_INDEX = { "月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6 };
  const _today = new Date(); _today.setHours(0, 0, 0, 0); // 本日(未到来日を分母から除外)
  for (const key of Object.keys(latest)) {
    const row = latest[key];
    const staff = String(row[idxStaff] || "").trim();
    const dateStr = String(row[idxDate] || "").trim();
    const m = dateStr.match(/(\d+)\//);
    if (!m) continue;
    const month = parseInt(m[1], 10);
    const acqStr = String(row[idxAcq] || "");
    const year = parseInt(acqStr.substring(0, 4), 10);
    if (isNaN(year)) continue;
    const ym = year + "-" + ("0" + month).slice(-2);

    const sec = parseTimeToSeconds(row[idxActual]);
    if (!monthly[staff]) monthly[staff] = {};
    if (!monthly[staff][ym]) monthly[staff][ym] = { over: 0, spec: 0 };
    if (sec >= SPECIAL_THRESHOLD_SECONDS) {
      monthly[staff][ym].spec += sec;
    } else {
      monthly[staff][ym].over += sec;
    }

    // 曜日 + 日 + 出勤判定
    const wm = dateStr.match(/\((.)\)/);
    const wd = wm ? wm[1] : "";
    const dm = dateStr.match(/\/(\d+)/);
    const day = dm ? parseInt(dm[1], 10) : 0;
    const workedFlag = (idxIn >= 0) ? (parseTimeToSeconds(row[idxIn]) > 0) : false;

    // 土日出勤判定 (土日両方出勤の週末数用)
    if ((wd === "土" || wd === "日") && day > 0 && idxIn >= 0) {
      if (!weekend[staff]) weekend[staff] = {};
      if (!weekend[staff][ym]) weekend[staff][ym] = { sat: {}, sun: {} };
      if (wd === "土") weekend[staff][ym].sat[day] = workedFlag;
      else weekend[staff][ym].sun[day] = workedFlag;
    }

    // 曜日別 出勤率用 (未到来日は分母から除外)
    const wi = WD_INDEX[wd];
    if (wi != null && day > 0 && idxIn >= 0) {
      const rowDate = new Date(year, month - 1, day);
      if (rowDate <= _today) { // 到来済みのみ
        if (!wdstat[staff]) wdstat[staff] = {};
        if (!wdstat[staff][ym]) {
          wdstat[staff][ym] = { worked: [0,0,0,0,0,0,0], occ: [0,0,0,0,0,0,0] };
        }
        wdstat[staff][ym].occ[wi]++;
        if (workedFlag) wdstat[staff][ym].worked[wi]++;
      }
    }
  }

  // (staff, ym) → 土日両方出勤した週末数 (土曜d-1 と 日曜d の両方出勤)
  function bothWorkedCount(staff, ym) {
    const w = weekend[staff] && weekend[staff][ym];
    if (!w) return 0;
    let cnt = 0;
    for (const sunDayStr of Object.keys(w.sun)) {
      const sun = parseInt(sunDayStr, 10);
      const sat = sun - 1;
      if (!(sat in w.sat)) continue;
      if (w.sat[sat] && w.sun[sun]) cnt++;
    }
    return cnt;
  }

  // 全月リスト
  const monthSet = {};
  Object.values(monthly).forEach(staffMap => {
    Object.keys(staffMap).forEach(ym => { monthSet[ym] = true; });
  });
  const months = Object.keys(monthSet).sort();

  // スタッフ別データ
  const allStaff = Object.keys(monthly).sort();
  const staffData = allStaff.map(name => {
    const m = monthly[name];
    let cumOver = 0, cumSpec = 0;
    const monthlyOver = [];
    const monthlySpec = [];
    const cumulativeOver = [];
    const cumulativeSpec = [];
    const monthlyWeekendBoth = [];  // 各月の土日両方出勤の週末数
    const monthlyWeekday = [];      // 各月の曜日別 {worked:[7], occ:[7]}
    months.forEach(ym => {
      const v = m[ym] || { over: 0, spec: 0 };
      monthlyOver.push(v.over);
      monthlySpec.push(v.spec);
      cumOver += v.over;
      cumSpec += v.spec;
      cumulativeOver.push(cumOver);
      cumulativeSpec.push(cumSpec);
      monthlyWeekendBoth.push(bothWorkedCount(name, ym));
      const ws = (wdstat[name] && wdstat[name][ym]) ||
                 { worked: [0,0,0,0,0,0,0], occ: [0,0,0,0,0,0,0] };
      monthlyWeekday.push(ws);
    });
    return { name, monthlyOver, monthlySpec, cumulativeOver, cumulativeSpec,
             monthlyWeekendBoth, monthlyWeekday };
  });

  return {
    months,
    staff: staffData,
    threshold_seconds: SPECIAL_THRESHOLD_SECONDS,
    // 将来 残業申請データができたらここに { applied: {...}, variance: {...} } を追加
  };
}


/**
 * スプレッドシート内の "スタッフタブ" の名前一覧を返す。
 * マスター/集計タブは除外。
 */
function getStaffList() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets()
    .map(s => s.getName())
    .filter(n => EXCLUDED_TABS.indexOf(n) < 0)
    .sort();
  return { staff: sheets };
}


/**
 * 指定スタッフタブの内容を返す。
 * セル値は表示形式(時刻なら "9:13" のような文字列)で返却。
 * 取得日時列で「最新スナップショット」だけにフィルタリング (毎日蓄積する仕様のため)。
 */
function getStaffDetail(name) {
  if (!name) throw new Error("name パラメータ必須");
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const ws = ss.getSheetByName(name);
  if (!ws) throw new Error("タブが見つかりません: " + name);

  const formatted = ws.getDataRange().getDisplayValues();
  if (!formatted.length) {
    return { name, header: [], rows: [] };
  }

  const header = formatted[0];
  const rows = formatted.slice(1);

  const idxAcq = header.findIndex(h => /取得日時/.test(h || ""));
  const idxDate = header.findIndex(h => /日付/.test(h || ""));
  if (idxAcq < 0 || idxDate < 0) {
    return { name, header, rows };
  }

  // (日付 + 取得日時の年) ごとに最新スナップショットを採用。
  // これにより異なる月/年の同じ日付 (例: 5/1) も区別できる。
  const latest = {};
  for (const r of rows) {
    const dateStr = String(r[idxDate] || "").trim();
    if (!dateStr) continue;
    const acq = String(r[idxAcq] || "");
    const year = acq.substring(0, 4); // 取得日時から年を抽出
    const key = year + "|" + dateStr;
    if (!latest[key] || String(latest[key][idxAcq]) < acq) {
      latest[key] = r;
    }
  }

  // ソート: 取得日時(年) → 日付 で昇順、合計行は末尾
  const filtered = Object.values(latest).sort((a, b) => {
    const acqA = String(a[idxAcq] || "");
    const acqB = String(b[idxAcq] || "");
    const yearA = acqA.substring(0, 4);
    const yearB = acqB.substring(0, 4);
    if (yearA !== yearB) return yearA.localeCompare(yearB);
    const da = String(a[idxDate]);
    const db = String(b[idxDate]);
    const aIsSum = da.indexOf("合計") >= 0;
    const bIsSum = db.indexOf("合計") >= 0;
    if (aIsSum && !bIsSum) return 1;
    if (!aIsSum && bIsSum) return -1;
    return da.localeCompare(db);
  });

  return {
    name,
    header,
    rows: filtered,
  };
}


/**
 * 休暇・託児フォームの回答スプレッドシートを読み、全シートの生データを返す。
 * イントラ側で detectKind により care / leave を自動判別して取り込む。
 * セルは表示文字列 (getDisplayValues) で返す (日付・時刻の解釈はイントラ側)。
 * 返却: { sheets: [ { name, rows: [[...], ...] }, ... ] }
 */
function getFormData() {
  const ss = SpreadsheetApp.openById(FORM_SHEET_ID);
  const sheets = ss.getSheets().map(sh => {
    let rows = [];
    try {
      rows = sh.getDataRange().getDisplayValues();
    } catch (e) {
      rows = [];
    }
    return { name: sh.getName(), rows: rows };
  });
  return { sheets: sheets };
}


/**
 * ============================================================
 *  有給休暇申請フォームのプルダウン自動同期
 * ============================================================
 *
 * Google フォームのプルダウン質問 (申請者氏名) を、スプレッドシート内の
 * 現職スタッフ一覧で自動更新する。
 *
 * セットアップ:
 *   1. Google フォームを作成: <https://forms.google.com/>
 *   2. 「プルダウン」型の質問を追加し、タイトルを LEAVE_FORM_QUESTION_TITLE
 *      (デフォルト "申請者氏名") に設定
 *   3. フォームURL https://docs.google.com/forms/d/【ここ】/edit の【】部分をコピーし、
 *      下の LEAVE_FORM_ID に貼り付け
 *   4. Apps Script エディタで、syncStaffNamesToForm を一度手動実行 (権限承認)
 *   5. 左サイドバーの 時計アイコン (トリガー) → トリガーを追加:
 *        - 関数: syncStaffNamesToForm
 *        - イベントのソース: 時間主導型
 *        - トリガータイプ: 日付ベースのタイマー
 *        - 時刻: 午前1時〜2時 (main.py が 0時に動くのでその後)
 *
 * これで毎日、入退職が反映されたプルダウンになる。
 */

// ★ 名簿(スタッフ名)を自動同期するフォーム一覧 ★
//   id    : フォームURL https://docs.google.com/forms/d/【ここ】/edit の【】部分
//   title : プルダウン質問のタイトル (部分一致で照合。"申請者" は "申請者氏名" にも一致)
// フォームを追加したい場合はこの配列に1行足すだけ。
const STAFF_SYNC_FORMS = [
  { id: "1eEvys3DDTeyzZN_9ZUYBqP6VSsq-q_XSUESaqqGfXyE", title: "申請者氏名" },  // 休暇申請フォーム
  { id: "1crR0hyyZIT6pfzPf-R6LEtfJFTGDiuDpy1_FtuLp9wc", title: "申請者" },        // 申請者フォーム(2問目)
];


// ふりがな対応表のタブ名 (氏名 | よみがな)
const FURIGANA_TAB = "ふりがな";


/** カタカナをひらがなに変換 (ソートキー正規化用)。 */
function kataToHira(s) {
  return String(s || "").replace(/[ァ-ヶ]/g,
    c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}


/**
 * 「ふりがな」タブを読み込み、{ sheet, map } を返す。
 * タブが無ければ作成し、ヘッダを入れる。map は { 氏名: よみがな }。
 */
function getFuriganaMap(ss) {
  let sheet = ss.getSheetByName(FURIGANA_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(FURIGANA_TAB);
    sheet.getRange(1, 1, 1, 2).setValues([["氏名", "よみがな"]]);
  }
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || "").trim();
    const yomi = String(data[i][1] || "").trim();
    if (name) map[name] = yomi;
  }
  return { sheet, map };
}


/**
 * ふりがな表に未登録のスタッフ名を空欄よみで追加する。
 * 新入職者を自動でふりがな表に出すための処理。追加した名前の配列を返す。
 */
function ensureFuriganaRows(sheet, map, names) {
  const missing = names.filter(n => !(n in map));
  if (missing.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, missing.length, 2)
      .setValues(missing.map(n => [n, ""]));
    missing.forEach(n => { map[n] = ""; });
  }
  return missing;
}


function syncStaffNamesToForm() {
  if (!STAFF_SYNC_FORMS || STAFF_SYNC_FORMS.length === 0) {
    throw new Error("STAFF_SYNC_FORMS が未設定です。apps_script.gs を編集してください。");
  }

  // スタッフタブ一覧を取得
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const allTabs = ss.getSheets().map(s => s.getName());
  const staffTabs = allTabs.filter(n => EXCLUDED_TABS.indexOf(n) < 0 && n !== FURIGANA_TAB);

  // "氏名 (コード)" → "氏名"
  const names = staffTabs
    .map(label => {
      const m = label.match(/^(.+?)\s*\(/);
      return m ? m[1].trim() : label.trim();
    })
    .filter(n => n);

  const unique = Array.from(new Set(names));
  if (unique.length === 0) {
    throw new Error("スタッフ名を抽出できませんでした。");
  }

  // ふりがな表を読み込み、未登録者を追加
  const { sheet: furiSheet, map: furiMap } = getFuriganaMap(ss);
  const added = ensureFuriganaRows(furiSheet, furiMap, unique);

  // ソート: よみがな(あれば) → 無ければ漢字。
  // よみ(ひらがな)は漢字よりコードが小さいので、よみ未登録者は末尾に集まる。
  unique.sort((a, b) => {
    const ka = kataToHira(furiMap[a]) || a;
    const kb = kataToHira(furiMap[b]) || b;
    return ka.localeCompare(kb, "ja");
  });

  // 各フォームのプルダウンを更新 (1つ失敗しても他は続行)
  const results = [];
  STAFF_SYNC_FORMS.forEach(cfg => {
    try {
      const form = FormApp.openById(cfg.id);
      const items = form.getItems(FormApp.ItemType.LIST);  // プルダウン質問のみ
      // タイトルが title に一致(完全一致優先、なければ部分一致)するプルダウンを探す
      let target = items.find(it => it.getTitle() === cfg.title);
      if (!target) target = items.find(it => it.getTitle().indexOf(cfg.title) >= 0);
      if (!target) {
        const titles = form.getItems().map(it => it.getTitle());
        results.push("[NG] " + cfg.id + " 質問'" + cfg.title + "'なし 候補:" + JSON.stringify(titles));
        return;
      }
      target.asListItem().setChoiceValues(unique);
      results.push("[OK] " + cfg.title + " (" + cfg.id.slice(0, 8) + "...) 更新");
    } catch (e) {
      results.push("[ERR] " + cfg.id + " : " + (e && e.message || e));
    }
  });

  const noYomi = unique.filter(n => !furiMap[n]);
  Logger.log("対象フォーム数: " + STAFF_SYNC_FORMS.length + " / スタッフ " + unique.length + " 名");
  results.forEach(r => Logger.log(r));
  Logger.log("最初の5名: " + unique.slice(0, 5).join(" / "));
  if (added.length > 0) Logger.log("ふりがな表に新規追加(よみ未入力): " + added.join(" / "));
  if (noYomi.length > 0) Logger.log("よみ未入力で末尾に並ぶ人数: " + noYomi.length);
  return { forms: STAFF_SYNC_FORMS.length, count: unique.length, results: results };
}


/**
 * 時刻文字列または時刻シリアル数値を秒数に変換。
 */
function parseTimeToSeconds(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Math.round(v * 86400);
  const s = String(v).trim();
  if (!s) return 0;
  if (s.indexOf(":") >= 0) {
    const parts = s.split(":");
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const sec = parts.length > 2 ? (parseInt(parts[2], 10) || 0) : 0;
    return h * 3600 + m * 60 + sec;
  }
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return Math.round(n * 86400);
}
