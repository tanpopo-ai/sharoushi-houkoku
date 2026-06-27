# ジョブカン取り込みのクラウド自動化 (GitHub Actions) セットアップ

PCの電源に関係なく、毎日クラウドでジョブカン勤怠を取り込みます。
一度設定すれば、以後は放置でOKです。

仕組み: GitHub Actions が毎日 **JST 0:30** に `jobcan_sync/main.py` を実行
→ ジョブカンへログイン(Playwright)→ CSV/出勤簿ダウンロード
→ Googleスプレッドシートへ反映。

---

## 1. Googleサービスアカウントを作る (Google認証・無人運用用)

1. https://console.cloud.google.com/ を開く(s-fujikado@tanpopo-dc.com)
2. 上部でプロジェクトを選択(無ければ「新しいプロジェクト」を作成)
3. 「APIとサービス」→「ライブラリ」で次の2つを **有効化**:
   - **Google Sheets API**
   - **Google Drive API**
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→ **サービスアカウント**
   - 名前: 例 `jobcan-sync` → 作成して完了
5. 作成したサービスアカウントを開く →「キー」タブ →「鍵を追加」→「新しい鍵」→ **JSON** を選択
   → JSONファイルがダウンロードされます(**この中身を後で使います。外部に出さないこと**)
6. そのサービスアカウントの **メールアドレス**(`xxxx@xxxx.iam.gserviceaccount.com`)をコピー

## 2. スプレッドシートをサービスアカウントに共有

1. スプレッドシート「**ジョブカン勤怠ログ**」を開く
2. 右上「共有」→ 1-6でコピーした **サービスアカウントのメール** を追加 → 権限 **編集者** → 送信
   - (これでクラウドからこのシートに書き込めます)

## 3. GitHub に Secrets を登録

GitHub リポジトリ `tanpopo-ai/sharoushi-houkoku` →「Settings」→「Secrets and variables」→「Actions」
→「New repository secret」で次の **4つ** を登録:

| 名前 | 値 |
|---|---|
| `JOBCAN_CLIENT_ID` | ジョブカンの会社ID(client_id) |
| `JOBCAN_LOGIN_ID` | ログイン用のメール or スタッフコード |
| `JOBCAN_PASSWORD` | ジョブカンのパスワード |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 1-5でDLしたJSONファイルの**中身を全部**貼り付け |

※ Secrets は暗号化保存され、GitHub管理者しか取り出せません。

## 4. 動作確認(手動実行)

1. GitHub →「Actions」タブ →「jobcan-sync」→「Run workflow」→ 実行
2. 数分後、緑チェック(成功)になればOK。
   失敗時はログ(成果物 `jobcan-sync-logs`)を確認。
3. イントラを Ctrl+Shift+R で開き、当日までデータが入っているか確認。

## 5. PC側の自動実行を停止(二重取り込み防止)

クラウドに移行できたら、PCのタスクスケジューラの該当タスク
(`register_task.ps1` / `register_verify_tasks.ps1` で作成したもの)を
**無効化**してください(二重実行を防ぐため)。

---

## 補足
- 実行時刻の変更: `.github/workflows/jobcan-sync.yml` の `cron`(UTC基準)。
- ジョブカンのアクセストークン有効期限(1年)はこの方式では不要(画面ログイン方式のため)。
- ローカルPCでも従来どおり動きます(環境変数が無ければ keyring / token.json を使用)。
