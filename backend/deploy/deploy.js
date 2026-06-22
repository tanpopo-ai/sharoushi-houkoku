/*
 * Apps Script (ジョブカン勤怠API) を Node から直接デプロイする。
 *
 * clasp の認証情報 (~/.clasprc.json) を再利用するので、新しいOAuth設定は不要。
 * (clasp は clone/pull にバグがあるが、ここでは Apps Script API を直接呼ぶので回避)
 *
 * やること:
 *   1. backend/apps_script.gs の内容を Apps Script プロジェクトに反映 (updateContent)
 *   2. 新しいバージョンを作成
 *   3. 既存のウェブアプリ デプロイを新バージョンに更新 (= 同じURLのまま再デプロイ)
 *
 * 前提:
 *   - Node.js / clasp 導入済み、`clasp login` 済み (= ~/.clasprc.json が存在)
 *   - このフォルダで `npm install` 済み
 * 実行:
 *   node deploy.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { google } = require("googleapis");

// スクリプトIDは名前からDriveで自動取得する (ハードコードの転記ミスを防ぐ)
const SCRIPT_NAME = "ジョブカン勤怠API";
const CODE_FILE = path.join(__dirname, "..", "apps_script.gs"); // backend/apps_script.gs
const CLASP_RC = path.join(os.homedir(), ".clasprc.json");

function loadAuth() {
  if (!fs.existsSync(CLASP_RC)) {
    throw new Error("~/.clasprc.json が見つかりません。先に `clasp login` を実行してください。");
  }
  const rc = JSON.parse(fs.readFileSync(CLASP_RC, "utf8"));
  const cs = rc.oauth2ClientSettings || (rc.tokens && rc.tokens.default) || {};
  const clientId = cs.clientId || cs.client_id;
  const clientSecret = cs.clientSecret || cs.client_secret;
  const refreshToken = (rc.token && rc.token.refresh_token) ||
                       (rc.tokens && rc.tokens.default && rc.tokens.default.refresh_token);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("認証情報を ~/.clasprc.json から取得できませんでした。`clasp login` をやり直してください。");
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

async function resolveScriptId(auth) {
  const drive = google.drive({ version: "v3", auth });
  const fl = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.script' and trashed=false and name='" + SCRIPT_NAME + "'",
    fields: "files(id,name,shortcutDetails)",
    pageSize: 5,
  });
  const files = fl.data.files || [];
  if (!files.length) throw new Error("Scriptプロジェクト '" + SCRIPT_NAME + "' が見つかりません");
  const f = files[0];
  return (f.shortcutDetails && f.shortcutDetails.targetId) || f.id;
}

async function main() {
  const auth = loadAuth();
  const script = google.script({ version: "v1", auth });
  const SCRIPT_ID = await resolveScriptId(auth);
  console.log("対象スクリプトID: " + SCRIPT_ID);

  // 1) 現在の内容を取得 (マニフェスト等を保持するため)
  const cur = await script.projects.getContent({ scriptId: SCRIPT_ID });
  const files = cur.data.files || [];
  const code = fs.readFileSync(CODE_FILE, "utf8");

  // SERVER_JS (コード本体) のソースを差し替え
  const serverFiles = files.filter(f => f.type === "SERVER_JS");
  if (serverFiles.length === 0) throw new Error("プロジェクトにSERVER_JSファイルがありません");
  if (serverFiles.length > 1) {
    console.warn("注意: SERVER_JSが複数あります。先頭(" + serverFiles[0].name + ")を更新します。");
  }
  serverFiles[0].source = code;
  console.log("反映先ファイル: " + serverFiles[0].name + ".gs (" + code.length + " 文字)");

  // 2) コード反映
  await script.projects.updateContent({ scriptId: SCRIPT_ID, requestBody: { files } });
  console.log("[OK] コード反映 (updateContent)");

  // 3) 新バージョン作成
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const ver = await script.projects.versions.create({
    scriptId: SCRIPT_ID,
    requestBody: { description: "auto-deploy " + stamp },
  });
  const versionNumber = ver.data.versionNumber;
  console.log("[OK] 新バージョン作成: v" + versionNumber);

  // 4) 既存ウェブアプリ デプロイを新バージョンに更新 (同じURL維持)
  const deps = await script.projects.deployments.list({ scriptId: SCRIPT_ID });
  const list = deps.data.deployments || [];
  // @HEAD (versionNumberなし) を除き、WEB_APP のデプロイを対象にする
  let target = list.find(d =>
    (d.deploymentConfig || {}).versionNumber != null &&
    (d.entryPoints || []).some(e => e.entryPointType === "WEB_APP"));
  if (!target) target = list.find(d => (d.deploymentConfig || {}).versionNumber != null);
  if (!target) throw new Error("更新対象のウェブアプリ デプロイが見つかりません");

  await script.projects.deployments.update({
    scriptId: SCRIPT_ID,
    deploymentId: target.deploymentId,
    requestBody: {
      deploymentConfig: {
        scriptId: SCRIPT_ID,
        versionNumber: versionNumber,
        manifestFileName: "appsscript",
        description: "auto-deploy " + stamp,
      },
    },
  });
  console.log("[OK] 再デプロイ完了 (同じURL): " + target.deploymentId);
  console.log("=== デプロイ成功 ===");
}

main().catch(e => {
  console.error("ERROR:", (e && e.message) || e);
  process.exit(1);
});
