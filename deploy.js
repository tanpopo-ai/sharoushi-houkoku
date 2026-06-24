#!/usr/bin/env node
/*
 * 社労士報告イントラ フロントエンド(index.html)を
 * GitHub Pages のライブサイトへ「1コマンドで」公開する Node ツール。
 *
 *   ライブサイト: https://tanpopo-ai.github.io/sharoushi-houkoku/
 *
 * やること:
 *   1. 未コミットの変更があれば commit (メッセージは自動 or 引数で指定)
 *   2. origin/main を取り込む (他デバイス/Claude の変更との衝突を回避)
 *   3. 現在の内容を main へ push  → GitHub Pages が自動で再ビルド (1〜2分)
 *
 * 前提:
 *   - git 導入済み
 *   - このリポジトリ (tanpopo-ai/sharoushi-houkoku) へ push できる GitHub 認証済み
 *   - 追加の npm install は不要 (git を呼ぶだけ)
 *
 * 実行:
 *   node deploy.js                         … 自動メッセージで公開
 *   node deploy.js "個人別タブに列を追加"   … コミットメッセージを指定して公開
 *   npm run deploy                          … 上と同じ (package.json 経由)
 *
 * 注意:
 *   この main への push がそのままライブ公開になります。
 *   バックエンド(backend/apps_script.gs)の Apps Script への反映は
 *   別ツール `node backend/deploy/deploy.js` を使ってください。
 */
"use strict";

const { execFileSync } = require("child_process");

const REMOTE = "origin";
const BRANCH = "main";
const LIVE_URL = "https://tanpopo-ai.github.io/sharoushi-houkoku/";

// git をリポジトリルートで実行する小ヘルパ
function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: __dirname,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

// 失敗してもよい git (例: 初回 fetch で origin/main が無い等)
function gitSafe(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.message || "").toString() };
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}:${p(d.getMinutes())}`;
}

function main() {
  // ここが git リポジトリであることを確認
  const inside = gitSafe(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    throw new Error("git リポジトリ内で実行してください。");
  }

  // 1) 未コミットの変更があれば commit
  const status = git(["status", "--porcelain"]).trim();
  if (status) {
    const msg = process.argv.slice(2).join(" ").trim() || `update ${nowStamp()}`;
    git(["add", "-A"]);
    git(["commit", "-m", msg], { inherit: true });
    console.log(`[OK] コミット: "${msg}"`);
  } else {
    console.log("[i] 未コミットの変更はありません。");
  }

  // 2) origin/main を取り込む (衝突回避)
  const fetched = gitSafe(["fetch", REMOTE, BRANCH]);
  if (fetched.ok) {
    const merge = gitSafe(["merge", "--no-edit", `${REMOTE}/${BRANCH}`]);
    if (!merge.ok) {
      gitSafe(["merge", "--abort"]);
      throw new Error(
        "origin/main の取り込みで衝突しました。\n" +
          "  別デバイス/Claude の変更と競合しています。手動で解決してから再実行してください:\n" +
          "    git pull origin main   (衝突を解消)  →  node deploy.js"
      );
    }
  } else {
    console.log("[i] origin/main を取得できませんでした (初回公開とみなして続行します)。");
  }

  // 3) main へ push (= ライブ公開)
  console.log(`[..] ${BRANCH} へ公開中...`);
  git(["push", REMOTE, `HEAD:${BRANCH}`], { inherit: true });

  console.log("\n=== 公開しました ===");
  console.log(`1〜2分後にライブサイトへ反映されます: ${LIVE_URL}`);
  console.log("(ブラウザは Ctrl+Shift+R で更新)");
}

try {
  main();
} catch (e) {
  console.error("\nERROR:", (e && e.message) || e);
  process.exit(1);
}
