/* 診断: 認証アカウントが見えるScriptプロジェクト一覧 + 対象IDをAPIで開けるか確認 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { google } = require("googleapis");

const TARGET = "1yFcaytRTN4m70RKBs7Ogy5UvO-jfljsObVNcTHIHe97ILA2GI2-kmBGb";

const rc = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".clasprc.json"), "utf8"));
const cs = rc.oauth2ClientSettings || {};
const o = new google.auth.OAuth2(cs.clientId, cs.clientSecret);
o.setCredentials({ refresh_token: rc.token.refresh_token });
const drive = google.drive({ version: "v3", auth: o });
const script = google.script({ version: "v1", auth: o });

(async () => {
  console.log("=== Scriptプロジェクト一覧 (Drive) ===");
  let driveId = null, driveName = null;
  try {
    const fl = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.script' and trashed=false",
      fields: "files(id,name,owners(emailAddress),driveId,shortcutDetails)",
      pageSize: 50,
    });
    const files = fl.data.files || [];
    files.forEach(f => {
      const owner = (f.owners && f.owners[0] && f.owners[0].emailAddress) || "?";
      const sc = f.shortcutDetails ? " [SHORTCUT→" + f.shortcutDetails.targetId + "]" : "";
      const sd = f.driveId ? " [共有ドライブ]" : "";
      console.log("  " + f.name + "  =>  " + f.id + "  owner=" + owner + sc + sd);
    });
    if (!files.length) console.log("  (なし)");
    const t = files.find(f => /ジョブカン/.test(f.name)) || files[0];
    if (t) {
      driveId = (t.shortcutDetails && t.shortcutDetails.targetId) || t.id;
      driveName = t.name;
    }
  } catch (e) {
    console.log("  Drive一覧エラー: " + (e.message || e));
  }

  console.log("=== projects.get (ハードコードTARGET) ===");
  console.log("  TARGET len=" + TARGET.length);
  try {
    const g = await script.projects.get({ scriptId: TARGET });
    console.log("  OK title=" + g.data.title);
  } catch (e) {
    console.log("  NG: " + (e.message || e));
  }

  console.log("=== projects.get (Drive由来ID) ===");
  if (driveId) {
    console.log("  driveId=" + driveId + "  len=" + driveId.length +
                "  同一?=" + (driveId === TARGET));
    try {
      const g = await script.projects.get({ scriptId: driveId });
      console.log("  OK title=" + g.data.title);
    } catch (e) {
      console.log("  NG: " + (e.message || e));
    }
  } else {
    console.log("  (Drive由来IDなし)");
  }
})().catch(e => console.error("FATAL:", e.message || e));
