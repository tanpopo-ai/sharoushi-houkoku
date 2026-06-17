# 複数デバイス運用ガイド (PowerShell コピペのみ)

このリポジトリ (社労士報告イントラ) を、複数のPCから GitHub 経由で
編集・公開するための手順。すべて **PowerShell に貼り付けるだけ** で完結します。

- ライブサイト: https://tanpopo-ai.github.io/sharoushi-houkoku/
- ローカル作業フォルダ: `%USERPROFILE%\tanpopo-sharoushi` (OneDrive外 = 安全)

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

## 運用フロー (まとめ)

```
[どのデバイスでも]
  1. B (最新取得) を貼り付け
  2. Claude Code に「○○を変更して」と依頼 → Claudeがこのフォルダを編集
  3. C (公開) を貼り付け → ライブ反映
```

- もう GitHub の Web 画面で PR をマージする必要はありません。
- Claude Code には「作業フォルダは %USERPROFILE%\tanpopo-sharoushi」と伝えればOK。

---

## トラブル時

| 症状 | 対処 |
|---|---|
| `git push` で認証を聞かれる | ブラウザでGitHubログイン許可 (初回のみ) |
| `CONFLICT` と出た | 別デバイスと同時編集で衝突。`git rebase --abort` 後に B→C をやり直し |
| `git: command not found` | Git for Windows をインストール |
| 反映されない | 1〜2分待って Ctrl+Shift+R。それでも駄目なら C を再実行 |
