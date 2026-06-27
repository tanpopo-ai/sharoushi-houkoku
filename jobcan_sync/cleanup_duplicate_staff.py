"""
同姓同名で社員コードが異なる "古い" スタッフを自動削除する。

判定ルール:
  1. スタッフタブ名 "氏名 (コード)" から氏名 (前カッコまでの部分) でグループ化
  2. 同名で複数コードがある場合、各タブの最新取得日時を比較
  3. 最新の方を残し、それ以外を「古い」とみなして削除
     - スタッフ別タブを削除
     - 出勤簿ログから当該スタッフラベルの行を削除

毎日 main.py の冒頭で呼ばれる想定。重複がなければ何もせず終了するので軽量。

使い方:
  python cleanup_duplicate_staff.py            # 実際に削除
  python cleanup_duplicate_staff.py --dry-run  # 削除予定だけログ表示
"""
from __future__ import annotations

import json
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

import gspread
from sheets_upload import _load_oauth_credentials, _api_retry

ROOT = Path(__file__).parent.resolve()
logger = logging.getLogger(__name__)

# マスタータブ (削除対象外)
EXCLUDED_TABS = {"勤務データログ", "出勤簿ログ", "集計", "シート1", "Sheet1"}


def parse_staff_label(label: str) -> tuple[str, str]:
    """'廣海 愛美 (66)' → ('廣海 愛美', '66'). カッコがなければ (label, '')。"""
    m = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", label)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return label.strip(), ""


def get_latest_acq(ws) -> str:
    """ワークシートのA列(取得日時)の最大値を返す。データなしは空文字。"""
    try:
        col = _api_retry(ws.col_values, 1)
    except Exception as e:
        logger.warning("'%s' のA列取得失敗: %s", ws.title, e)
        return ""
    if len(col) < 2:
        return ""
    return max((v for v in col[1:] if v), default="")


def cleanup(config: dict, dry_run: bool = False) -> int:
    """同姓同名の古いスタッフタブを削除。削除した数を返す。"""
    creds = _load_oauth_credentials(config)
    client = gspread.authorize(creds)
    sh = client.open_by_key(config["google"]["spreadsheet_id"])

    all_sheets = _api_retry(sh.worksheets)
    staff_tabs = [ws for ws in all_sheets if ws.title not in EXCLUDED_TABS]
    logger.info("スタッフタブ検査: %d 個", len(staff_tabs))

    # 氏名でグループ化
    by_name: dict[str, list[tuple[gspread.Worksheet, str]]] = defaultdict(list)
    for ws in staff_tabs:
        name, code = parse_staff_label(ws.title)
        by_name[name].append((ws, code))

    duplicates = {n: items for n, items in by_name.items() if len(items) > 1}
    if not duplicates:
        logger.info("同姓同名の重複なし。クリーンアップ不要。")
        return 0

    logger.info("同姓同名で重複しているスタッフ: %d 名", len(duplicates))

    # 各グループで「古い方」を特定
    to_delete: list[tuple[gspread.Worksheet, str, str, str]] = []
    for name, items in duplicates.items():
        with_acq = []
        for ws, code in items:
            latest = get_latest_acq(ws)
            with_acq.append((ws, code, latest))
            logger.info("  %s (%s): 最新取得日時 = %s", name, code, latest or "(なし)")
        # 最新の取得日時を持つものを残す
        with_acq.sort(key=lambda x: x[2], reverse=True)
        keep_ws, keep_code, keep_acq = with_acq[0]
        logger.info("  → 残す: %s (%s)", name, keep_code)
        for ws, code, acq in with_acq[1:]:
            to_delete.append((ws, name, code, acq))
            logger.info("  → 削除予定: %s (%s)", name, code)

    if not to_delete:
        return 0

    if dry_run:
        logger.info("[DRY RUN] %d 個のスタッフタブ削除はスキップしました。", len(to_delete))
        return 0

    # スタッフタブを削除
    deleted = 0
    delete_labels = set()
    for ws, name, code, acq in to_delete:
        try:
            _api_retry(sh.del_worksheet, ws)
            logger.info("削除: スタッフタブ '%s (%s)'", name, code)
            delete_labels.add(f"{name} ({code})")
            deleted += 1
        except Exception as e:
            logger.error("タブ削除失敗 '%s (%s)': %s", name, code, e)

    # 出勤簿ログ・勤務データログ からも当該スタッフ行を削除
    for master_key in ("attendance_book_worksheet_name", "worksheet_name"):
        master_name = config["google"].get(master_key)
        if not master_name:
            continue
        try:
            _delete_rows_for_staff(sh, master_name, delete_labels)
        except Exception as e:
            logger.error("'%s' からの行削除失敗: %s", master_name, e)

    return deleted


def _delete_rows_for_staff(sh, master_name: str, delete_labels: set[str]) -> None:
    """マスターシートから、特定スタッフラベルの行を削除して書き戻す。"""
    try:
        ws = _api_retry(sh.worksheet, master_name)
    except gspread.WorksheetNotFound:
        logger.warning("'%s' タブが見つからずスキップ", master_name)
        return

    all_values = _api_retry(ws.get_all_values)
    if len(all_values) < 2:
        return

    header = all_values[0]
    idx_staff = next((i for i, h in enumerate(header) if "スタッフ" in (h or "")), -1)
    if idx_staff < 0:
        logger.warning("'%s' にスタッフ列が見当たらず行削除をスキップ", master_name)
        return

    keep_rows = [header]
    removed = 0
    for row in all_values[1:]:
        if len(row) > idx_staff and row[idx_staff] in delete_labels:
            removed += 1
            continue
        keep_rows.append(row)

    if removed == 0:
        return

    logger.info("'%s' から %d 行削除して書き戻し", master_name, removed)
    # クリア → バッチ書き込み
    _api_retry(ws.clear)
    BATCH = 500
    for i in range(0, len(keep_rows), BATCH):
        chunk = keep_rows[i:i + BATCH]
        _api_retry(ws.update, range_name=f"A{i + 1}",
                   values=chunk, value_input_option="USER_ENTERED")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    dry_run = "--dry-run" in sys.argv
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    n = cleanup(cfg, dry_run=dry_run)
    logger.info("クリーンアップ完了: %d スタッフタブ削除", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
