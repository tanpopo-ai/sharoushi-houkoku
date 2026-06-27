# ジョブカン取り込みのクラウド自動化 (GitHub Actions) セットアップ

PCの電源に関係なく、毎日クラウドでジョブカン勤怠を取り込みます。
一度設定すれば、以後は放置でOKです。

仕組み: GitHub Actions が毎日 **JST 0:30** に `jobcan_sync/main.py` を実行
→ ジョブカンへログイン(Playwright)→ CSV/出勤簿ダウンロード
→ Googleスプレッドシートへ反映。

> Google認証は、**今PCで使えている `token.json` をそのまま流用**します。
> (組織ポリシーでサービスアカウントの鍵作成が禁止されているため、こちらが簡単・確実)

---

## 1. Google認証 (token.json) を GitHub Secret に登録

1. お手元PCの **`token.json`** をメモ帳などで開く
   場所: `C:\Users\翔平\OneDrive\Desktop\ジョブカンExcel抜出\token.json`
2. **中身を全部コピー**(`{ ... }` 全体。改行含めてOK)
3. GitHub リポジトリ `tanpopo-ai/sharoushi-houkoku`
   →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」
4. 名前 `GOOGLE_OAUTH_TOKEN_JSON` / 値 = コピーした中身 → 保存

## 2. ジョブカン認証を GitHub Secrets に登録

同じ「New repository secret」で次の **3つ** を登録:

| 名前 | 値 |
|---|---|
| `JOBCAN_CLIENT_ID` | ジョブカンの会社ID(client_id) |
| `JOBCAN_LOGIN_ID` | ログイン用のメール or スタッフコード |
| `JOBCAN_PASSWORD` | ジョブカンのパスワード |

> これらは、PCで `setup_credentials.py` 実行時に入力した値です。
> (Windows資格情報マネージャーの `jobcan_attendance_downloader` にも保存されています)

## 3. 動作確認(手動実行)

1. GitHub →「Actions」タブ →「jobcan-sync」→「Run workflow」→ 実行
2. 数分後、緑チェック(成功)になればOK。
   失敗時はログ(成果物 `jobcan-sync-logs`)を確認。
3. イントラを Ctrl+Shift+R で開き、当日までデータが入っているか確認。

## 4. PC側の自動実行を停止(二重取り込み防止)

クラウドに移行できたら、PCのタスクスケジューラの該当タスク
(`register_task.ps1` / `register_verify_tasks.ps1` で作成したもの)を
**無効化**してください(二重実行を防ぐため)。

---

## 補足
- **Secrets は暗号化保存**され、GitHub管理者しか取り出せません。
- 実行時刻の変更: `.github/workflows/jobcan-sync.yml` の `cron`(UTC基準)。
- ローカルPCでも従来どおり動きます(環境変数が無ければ keyring / token.json を使用)。
- **token.json が将来失効した場合**(Googleのトークン失効・パスワード変更等):
  PCで一度 `python main.py`(または取り込み)を実行して `token.json` を再生成し、
  その中身で Secret `GOOGLE_OAUTH_TOKEN_JSON` を更新してください。
- 組織がサービスアカウント鍵を許可している場合は、代わりに
  `GOOGLE_SERVICE_ACCOUNT_JSON`(SAのJSON)を登録する方式にも対応しています
  (その場合はスプレッドシートをSAのメールに共有)。
