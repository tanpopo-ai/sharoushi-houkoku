# 複数デバイス運用ガイド

このリポジトリ (社労士報告イントラ) を、複数の環境から GitHub 経由で
編集・公開するための手順です。作業環境は2通りあります。

- **ローカルPC (Windows / PowerShell)** … → このページの A〜C
- **Claude Code on the web (ブラウザ / スマホからでもOK)** … → このページの D ★おすすめ★

共通情報:

- ライブサイト: https://tanpopo-ai.github.io/sharoushi-houkoku/
- GitHub リポジトリ: https://github.com/tanpopo-ai/sharoushi-houkoku
- 公開のしくみ: **`main` ブランチ**に入った内容が GitHub Pages で自動公開される(1〜2分後に反映)
- ローカル作業フォルダ (PowerShell運用時): `%USERPROFILE%\tanpopo-sharoushi` (OneDrive外 = 安全)

---

## A. 新しいデバイスで初回セットアップ (1回だけ)

PowerShell を開いて、以下をまるごと貼り付け:

```powershell
$r="$env:USERPROFILE\tanpopo-sharoushi"; if(!(Test-Path $r)){git clone https://github.com/tanpopo-ai/sharoushi-houkoku.git $r}; cd $r; git config user.name "s-fujikado"; git config user.email "s-fujikado@tanpopo-dc.com"; git pull
```

- 初回の `git clone` / `git push` で **ブラウザのGitHubログイン画面** が出たら、
  GitHubアカウントで許可してください (1回認証すれば以降は自動)。
- Git が入っていない場合は https://git-scm.com/download/win から
  「Git for Windows」をインストール (既定設定のままでOK)。

---

## B. 作業を始める前: 最新を取得

別デバイスでの変更を取り込むため、作業前に貼り付け:

```powershell
cd "$env:USERPROFILE\tanpopo-sharoushi"; git pull --rebase
```

---

## C. 変更をライブに公開

Claude Code で編集してもらった後、これを貼り付けるとライブサイトに反映:

```powershell
cd "$env:USERPROFILE\tanpopo-sharoushi"; git add -A; if(git status --porcelain){git commit -m ("update " + (Get-Date -Format "yyyy-MM-dd_HH:mm"))}; git pull --rebase; git push
```

→ 1〜2分後に https://tanpopo-ai.github.io/sharoushi-houkoku/ に反映されます。
   (ブラウザは Ctrl+Shift+R で更新)

---

## D. Claude Code on the web で作業する場合 (★おすすめ・PCソフト不要★)

ブラウザ(スマホ・タブレット可)から https://claude.ai/code を開くだけで、
**Git も PowerShell も自分の端末に入れずに**このプロジェクトを編集・公開できます。
リポジトリはセッション開始時に自動でクラウドにクローンされるので、初回セットアップは不要です。

### 手順

1. **https://claude.ai/code** を開く
2. リポジトリ **`tanpopo-ai/sharoushi-houkoku`** を選んでセッションを開始
3. チャットで「○○を変更して」と日本語で依頼する
   - 例:「個人別タブに△△の列を追加して」「トップの集計から□□を除外して」
4. Claude が編集し、`claude/...` という**作業ブランチに自動で commit & push** します
5. **ライブサイトに公開する**(= `main` へ反映)。おすすめは Node デプロイ:
   - Claude に「**公開して**」と頼む → Claude が **`node deploy.js`** を実行し、
     変更を `main` へ push → GitHub Pages が自動で再ビルド(下記「E. Nodeで一発公開」参照)
   - ※ PR でレビューしてから公開したい場合は、代わりに「**PRを作って**」と頼み、
     GitHub 上で **Merge** してもOK(従来どおり)
6. 1〜2分後にライブサイトへ自動反映(ブラウザは Ctrl+Shift+R)

### ローカル(A〜C)との違い

| | ローカル PowerShell (A〜C) | Claude Code on the web (D) |
|---|---|---|
| 必要なもの | PC・Git・PowerShell | ブラウザだけ(スマホ可) |
| 編集場所 | `%USERPROFILE%\tanpopo-sharoushi` | クラウド(セッション毎に自動クローン) |
| 公開方法 | `git push`(C を貼り付け)で main へ直接 | 作業ブランチ → **PR を Merge** で main へ |
| 反映 | どちらも main 反映後 1〜2分でライブ更新 | 同左 |

### 注意点

- クラウド環境は**セッション終了で破棄**されます。残したい変更は必ず **push / PR マージ**まで済ませること(Claude が自動で push するので通常は気にしなくてOK)。
- **公開の最後の一押し(PR の Merge)だけは人が行う**運用です。意図しない公開を防ぐため、Claude は main へ直接 push しません。
- バックエンド `backend/apps_script.gs` を変更した場合の Apps Script への反映は、ローカルと同じく手動です(下記セクション参照)。

---

## E. Node で一発公開 (`node deploy.js`) — どの環境でも共通

PowerShell の C と同じ「公開」を、**Node から1コマンド**で実行できます。
Windows / Mac / Claude Code on the web のどこでも同じコマンドで動きます
(git を呼ぶだけなので `npm install` 不要)。

```bash
# リポジトリのルートで:
node deploy.js
# または
npm run deploy

# コミットメッセージを指定したいとき:
node deploy.js "個人別タブに○○列を追加"
```

`node deploy.js` がやること:

1. 未コミットの変更があれば自動で commit(メッセージは引数 or `update 日時`)
2. `origin/main` を取り込み(他デバイス/Claude の変更との衝突を回避)
3. `main` へ push → GitHub Pages が自動で再ビルド → **1〜2分でライブ反映**

- **前提**: このリポジトリへ push できる GitHub 認証が済んでいること(初回はブラウザ認証)。
- **衝突したとき**: メッセージの指示どおり `git pull origin main` で解消してから再実行。
- これは**フロントエンド(index.html)専用**です。バックエンド(Apps Script)の反映は
  `node backend/deploy/deploy.js`(下記)を使ってください。

---

## 運用フロー (まとめ)

```
[ローカル PowerShell (A〜C)]
  1. B (最新取得) を貼り付け
  2. Claude Code に「○○を変更して」と依頼 → Claudeがこのフォルダを編集
  3. C (公開) を貼り付け → ライブ反映 (main へ直接 push)

[Claude Code on the web (D) ★おすすめ★]
  1. https://claude.ai/code で sharoushi-houkoku を開く
  2. 「○○を変更して」と依頼 → Claude が作業ブランチに push
  3. 「公開して」→ Claude が node deploy.js を実行 → ライブ反映
     (レビューしたいときは「PRを作って」→ GitHub で Merge でもOK)
```

- ローカル運用 (C) は main へ直接 push するため、GitHub の Web 画面での PR マージは不要です。
- ローカルの Claude Code には「作業フォルダは %USERPROFILE%\tanpopo-sharoushi」と伝えればOK。
- どの環境でも `node deploy.js`(E)で公開できます。web 運用なら Claude に「公開して」で完了。
- PC へのインストールは一切不要です(web 運用)。

---

## バックエンド (Apps Script) について

`backend/apps_script.gs` が Apps Script (ジョブカン勤怠API) のコードです。
- **どの端末からでも編集・同期できます** (このリポジトリに入っているため)。
- ただし **ライブのApps Scriptへの反映だけは手動**です (GitHubからは自動反映されない)。
- バックエンドを変更したとき(API追加・取得元変更など、稀)だけ、以下を実施:

  1. `backend/apps_script.gs` の中身を全コピー
     ```powershell
     notepad "$env:USERPROFILE\tanpopo-sharoushi\backend\apps_script.gs"
     ```
  2. Apps Scriptエディタ (https://script.google.com/) を開き、コードを全置換して保存 (Ctrl+S)
  3. 「デプロイ」→「デプロイを管理」→ ✏️ → バージョン「新しいバージョン」→「デプロイ」

- 画面(index.html)の変更だけなら、この手順は不要 (C の公開pasteだけでOK)。

---

## トラブル時

| 症状 | 対処 |
|---|---|
| `git push` で認証を聞かれる | ブラウザでGitHubログイン許可 (初回のみ) |
| `CONFLICT` と出た | 別デバイスと同時編集で衝突。`git rebase --abort` 後に B→C をやり直し |
| `git: command not found` | Git for Windows をインストール |
| 反映されない | 1〜2分待って Ctrl+Shift+R。それでも駄目なら C を再実行 |
