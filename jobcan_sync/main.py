"""
毎日0時に呼ばれるエントリポイント。
1) ジョブカンから勤怠CSVをダウンロード
2) Googleスプレッドシートに追記
3) ログを logs/ 配下に出力
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

import jobcan_download
import sheets_upload

ROOT = Path(__file__).parent.resolve()
LOCK_FILE = ROOT / "main.lock"
LOCK_STALE_MINUTES = 60  # ロックが古ければ無効と判断する


def _acquire_lock() -> bool:
    """二重起動防止ロック取得。既存ロックが新しければ False (起動中断)。"""
    if LOCK_FILE.exists():
        age_min = (time.time() - LOCK_FILE.stat().st_mtime) / 60.0
        if age_min < LOCK_STALE_MINUTES:
            return False
        # 古すぎるロックは無効化
    try:
        LOCK_FILE.write_text(str(os.getpid()), encoding="utf-8")
        return True
    except Exception:
        return False


def _release_lock() -> None:
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _setup_logging() -> None:
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "main.log"

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s - %(message)s")

    file_h = RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=10, encoding="utf-8")
    file_h.setFormatter(fmt)

    stream_h = logging.StreamHandler(sys.stdout)
    stream_h.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.addHandler(file_h)
    root.addHandler(stream_h)


def main() -> int:
    _setup_logging()
    log = logging.getLogger("main")

    # 二重起動防止
    if not _acquire_lock():
        log.warning("既に main.py が実行中のためスキップ (lock: %s)", LOCK_FILE)
        return 2

    log.info("=== 実行開始: %s ===", datetime.now().isoformat())

    try:
        cfg_path = ROOT / "config.json"
        config = json.loads(cfg_path.read_text(encoding="utf-8"))

        # === 0. 同姓同名の重複スタッフタブを整理 (古い方を削除) ===
        try:
            import cleanup_duplicate_staff
            cleanup_duplicate_staff.cleanup(config, dry_run=False)
        except Exception as e:
            log.warning("重複スタッフ整理でエラー (続行): %s", e)

        # === 1. 勤務データダウンロード (CSV) ===
        try:
            csv_path = jobcan_download.download_attendance_csv(config)
            added_csv = sheets_upload.upload_csv(config, csv_path)
            log.info("勤務データ: %d行追記", added_csv)
        except Exception as e:
            log.error("勤務データ取得・追記でエラー: %s", e)
            log.error(traceback.format_exc())
            added_csv = -1

        # === 2. 出勤簿一括ダウンロード (Excel) ===
        try:
            xlsx_path = jobcan_download.download_attendance_book(config)
            added_book = sheets_upload.upload_attendance_book(config, xlsx_path)
            log.info("出勤簿: %d行追記", added_book)
        except Exception as e:
            log.error("出勤簿取得・追記でエラー: %s", e)
            log.error(traceback.format_exc())
            added_book = -1

        log.info("=== 完了: 勤務データ=%d行 / 出勤簿=%d行 ===", added_csv, added_book)
        # どちらかが成功していれば exit 0
        # 出勤簿が成功している場合のみ完全成功とみなして exit 0
        # 勤務データのみ成功 (added_book < 0) は exit 3 (部分成功) で verify が再試行する余地を残す
        if added_book >= 0:
            return 0
        elif added_csv >= 0:
            return 3
        else:
            return 1
    except Exception as e:
        log.error("致命的エラー: %s", e)
        log.error(traceback.format_exc())
        return 1
    finally:
        _release_lock()


if __name__ == "__main__":
    sys.exit(main())
