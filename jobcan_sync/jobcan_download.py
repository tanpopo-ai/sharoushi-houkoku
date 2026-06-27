"""
ジョブカンへログインし、「勤務データダウンロード」ページから勤怠CSVを取得する。
(https://ssl.jobcan.jp/client/down-work)

フォーマットはジョブカン側で予め選んでいる「残業差分集計表」等を使う。
ファイル形式は CSV を明示的に選択。
期間は config.json の extraction.target に従う:
  yesterday      → 指定日(前日)
  today          → 指定日(当日)
  this_month     → 指定月(当月)
  previous_month → 指定月(前月)
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

SERVICE_NAME = "jobcan_attendance_downloader"
LOGIN_URL_DEFAULT = "https://ssl.jobcan.jp/login/client"
DOWNLOAD_URL_DEFAULT = "https://ssl.jobcan.jp/client/down-work"
ATTENDANCE_BOOK_URL_DEFAULT = "https://ssl.jobcan.jp/client/down-attendance"

logger = logging.getLogger(__name__)


def _load_credentials() -> dict:
    # クラウド(GitHub Actions)用: 環境変数があれば優先
    env_creds = {
        "client_id": os.environ.get("JOBCAN_CLIENT_ID"),
        "login_id": os.environ.get("JOBCAN_LOGIN_ID"),
        "password": os.environ.get("JOBCAN_PASSWORD"),
    }
    if all(env_creds.values()):
        return env_creds

    # ローカルPC用: Windows資格情報マネージャー(keyring)から取得
    import keyring
    creds = {
        "client_id": keyring.get_password(SERVICE_NAME, "client_id"),
        "login_id": keyring.get_password(SERVICE_NAME, "login_id"),
        "password": keyring.get_password(SERVICE_NAME, "password"),
    }
    missing = [k for k, v in creds.items() if not v]
    if missing:
        raise RuntimeError(
            f"資格情報が未設定です: {missing}. "
            "環境変数(JOBCAN_CLIENT_ID/JOBCAN_LOGIN_ID/JOBCAN_PASSWORD)か "
            "setup_credentials.py を設定してください。"
        )
    return creds


def _resolve_target_date(target: str) -> date:
    """期間指定の基準日。指定月の場合は当月の任意の1日を返す。"""
    today = date.today()
    if target == "today":
        return today
    if target == "yesterday":
        return today - timedelta(days=1)
    if target == "this_month":
        return today.replace(day=1)
    if target == "previous_month":
        first_this = today.replace(day=1)
        return (first_this - timedelta(days=1)).replace(day=1)
    raise ValueError(f"未知の extraction.target 指定: {target!r}")


def _login(page, creds: dict) -> None:
    logger.info("ジョブカンへログイン中...")
    page.fill('input[name="client_login_id"]', creds["client_id"], timeout=5000)
    page.fill('input[name="client_manager_login_id"]', creds["login_id"])
    page.fill('input[name="client_login_password"]', creds["password"])

    # ログイン前の画面状態をスクショ保存(デバッグ用)
    try:
        page.screenshot(path="debug_before_login_click.png", full_page=True)
    except Exception:
        pass

    # 複数のセレクタを試す。Jobcan側の小変更に強くなる。
    login_btn_selectors = [
        'button:has-text("ログイン")',
        'button[type="submit"]:visible',
        'input[type="submit"][value*="ログイン"]',
        'input[type="submit"]',
        '*:has-text("ログイン")[role="button"]',
    ]
    clicked = False
    for sel in login_btn_selectors:
        try:
            page.click(sel, timeout=3000)
            clicked = True
            logger.info("ログインボタンクリック成功: %s", sel)
            break
        except PWTimeout:
            continue
    if not clicked:
        # 最終手段: フォームを直接 submit
        try:
            page.evaluate("""() => {
                const form = document.querySelector('form');
                if (form) form.submit();
            }""")
            logger.info("ログイン: form.submit() で送信")
        except Exception as e:
            shot = Path("debug_login_button_not_found.png").resolve()
            try:
                page.screenshot(path=str(shot), full_page=True)
            except Exception:
                pass
            raise RuntimeError(
                f"ログインボタンが見つからず form.submit() も失敗: {e}. "
                f"スクショ: {shot}"
            )

    try:
        page.wait_for_url(lambda u: "/login/client" not in u, timeout=15000)
    except PWTimeout:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except PWTimeout:
        logger.warning("ログイン後 networkidle 15秒で達成せず。続行")

    if "/login/client" in page.url:
        shot = Path("debug_login_failed.png").resolve()
        try:
            page.screenshot(path=str(shot), full_page=True)
        except Exception:
            pass
        raise RuntimeError(f"ログイン失敗。{shot} を確認してください。")
    logger.info("ログイン成功: %s", page.url)


def _set_radio(page, input_id: str) -> None:
    """ラジオボタンをチェック。click()でJSハンドラも発火させ、結果を検証する。"""
    page.click(f'input#{input_id}')
    # change イベントを明示的に発火(カスタムスタイルのラジオで稀に必要)
    page.evaluate(
        f"""() => {{
            const el = document.getElementById('{input_id}');
            if (el) {{ el.checked = true; el.dispatchEvent(new Event('change', {{bubbles:true}})); }}
        }}"""
    )
    # 反映確認
    is_checked = page.evaluate(f"document.getElementById('{input_id}')?.checked")
    if not is_checked:
        logger.warning("ラジオ #%s のチェック反映が不確実", input_id)


def _configure_form(page, target: str, target_date: date) -> None:
    """勤務データダウンロード画面のフォームを設定する。"""
    # ファイル形式: CSV
    _set_radio(page, "csv_out")
    logger.info("ファイル形式: CSV")

    # 期間
    if target in ("yesterday", "today"):
        _set_radio(page, "submit_type_day")
        page.select_option('select[name="day_year"]', str(target_date.year))
        page.select_option('select[name="day_month"]', str(target_date.month))
        page.select_option('select[name="day_day"]', str(target_date.day))
        logger.info("期間設定: 指定日 %s", target_date.isoformat())
    elif target in ("this_month", "previous_month"):
        _set_radio(page, "submit_type_month")
        page.select_option('select[name="month_year"]', str(target_date.year))
        page.select_option('select[name="month_month"]', str(target_date.month))
        logger.info("期間設定: 指定月 %d年%d月", target_date.year, target_date.month)
    else:
        raise ValueError(f"未対応 target: {target}")


def _click_download(page):
    """ダウンロードボタンを押下し、ダウンロード完了を待つ。"""
    # ボタンはページ下部にあるので明示的にスクロール
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(500)

    # 「ダウンロード」要素を待つ
    try:
        page.wait_for_selector('#download-link, a:has-text("ダウンロード"), button:has-text("ダウンロード")',
                                timeout=15000, state="visible")
    except PWTimeout:
        logger.warning("ダウンロードボタン要素が15秒待っても現れず。")

    # クリック直前のスクショ(状態確認用)
    try:
        page.screenshot(path="debug_before_download.png", full_page=True)
    except Exception:
        pass

    # 候補セレクタ。前回のログから #download-link が正解と判明しているので最優先。
    candidates = [
        '#download-link',
        'a#download-link',
        'form[action$="/down-work/download"] button[type="submit"]',
        'form[action$="/down-work/download"] input[type="submit"]',
        'form[action$="/down-work/download"] button',
        'button:has-text("ダウンロード"):visible',
        'a:has-text("ダウンロード"):visible',
    ]

    with page.expect_download(timeout=300_000) as dl_info:
        clicked_sel = None
        for sel in candidates:
            try:
                page.click(sel, timeout=3000)
                clicked_sel = sel
                break
            except PWTimeout:
                continue

        # 全部失敗したらJS経由で直接フォームsubmit
        if not clicked_sel:
            logger.info("セレクタ総当たり失敗。JS経由でフォーム送信を試行。")
            try:
                page.evaluate(
                    """() => {
                        const forms = document.querySelectorAll('form[action$="/down-work/download"]');
                        if (forms.length > 0) { forms[0].submit(); }
                    }"""
                )
                clicked_sel = "(JS form.submit)"
            except Exception as e:
                logger.warning("JS送信も失敗: %s", e)

        if not clicked_sel:
            shot = Path("debug_no_download_button.png").resolve()
            try:
                page.screenshot(path=str(shot), full_page=True)
            except Exception:
                pass
            raise RuntimeError(f"ダウンロードボタンが見つかりません。{shot} 参照。")
        logger.info("ダウンロードボタン押下: %s", clicked_sel)

    return dl_info.value


def download_attendance_csv(config: dict) -> Path:
    """設定に従って勤務データCSVをダウンロードし、保存パスを返す。"""
    jc = config["jobcan"]
    creds = _load_credentials()

    download_dir = Path(jc.get("download_dir", "downloads")).resolve()
    download_dir.mkdir(parents=True, exist_ok=True)

    target = config["extraction"]["target"]
    target_date = _resolve_target_date(target)
    logger.info("取得対象: %s (基準日: %s)", target, target_date)

    login_url = jc.get("login_url", LOGIN_URL_DEFAULT)
    download_url = jc.get("download_url", DOWNLOAD_URL_DEFAULT)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=jc.get("headless", True))
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        # ログイン
        page.goto(login_url, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except PWTimeout:
            logger.warning("ログイン画面 networkidle タイムアウト。続行")
        _login(page, creds)

        # 勤務データダウンロード画面
        logger.info("勤務データダウンロード画面へ遷移: %s", download_url)
        page.goto(download_url, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except PWTimeout:
            logger.warning("勤務データ画面 networkidle タイムアウト。続行")
        try:
            page.wait_for_selector('input#csv_out', timeout=15000, state="attached")
        except PWTimeout:
            logger.warning("csv_out 要素待機タイムアウト。続行")

        # フォーム設定
        _configure_form(page, target, target_date)

        # 軽い待機(JSの整合のため)
        page.wait_for_timeout(500)

        # ダウンロード実行
        download = _click_download(page)

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        saved = download_dir / f"work_data_{target_date.isoformat()}_{timestamp}.csv"
        download.save_as(saved)
        logger.info("CSV保存: %s", saved)

        browser.close()
        return saved


def _current_month_range() -> tuple[date, date]:
    """当月の1日と末日を返す。"""
    today = date.today()
    start = today.replace(day=1)
    if today.month == 12:
        end = date(today.year + 1, 1, 1) - timedelta(days=1)
    else:
        end = date(today.year, today.month + 1, 1) - timedelta(days=1)
    return start, end


def download_attendance_book(config: dict) -> Path:
    """「出勤簿一括ダウンロード」画面からExcelファイル(複数名分・複数シート)を取得する。

    当月1日〜末日の期間指定で取得。サーバー側で生成に時間がかかる場合があるため
    最大30分待つ。
    """
    jc = config["jobcan"]
    creds = _load_credentials()

    download_dir = Path(jc.get("download_dir", "downloads")).resolve()
    download_dir.mkdir(parents=True, exist_ok=True)

    start_d, end_d = _current_month_range()
    logger.info("出勤簿取得期間: %s 〜 %s", start_d, end_d)

    login_url = jc.get("login_url", LOGIN_URL_DEFAULT)
    book_url = jc.get("attendance_book_url", ATTENDANCE_BOOK_URL_DEFAULT)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=jc.get("headless", True))
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        # ログイン
        page.goto(login_url, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=15000)
        _login(page, creds)

        # 出勤簿一括ダウンロード画面
        logger.info("出勤簿一括ダウンロード画面へ遷移: %s", book_url)
        page.goto(book_url, wait_until="domcontentloaded")
        # networkidle はジョブカン側のポーリングで稀に静止しないため、緩く待つ
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except PWTimeout:
            logger.warning("networkidle 10秒で達成せず。続行 (domcontentloaded は完了)")
        # フォーム要素が表示されるまで明示的に待つ
        try:
            page.wait_for_selector('input#excel_out', timeout=15000, state="attached")
        except PWTimeout:
            logger.warning("excel_out 要素待機タイムアウト。続行")

        # ファイル形式: Excel (radioの name=pdf, value=0, id=excel_out)
        _set_radio(page, "excel_out")
        logger.info("出勤簿: ファイル形式 Excel")

        # シート構成: 複数名分(複数シート) → 1つのxlsxに全スタッフを格納
        _set_radio(page, "number_of_afile_several")
        logger.info("出勤簿: 複数名分(複数シート)に設定")

        # 期間: 指定期間 (search_type=term)
        try:
            page.click('input[name="search_type"][value="term"]')
        except PWTimeout:
            logger.warning("指定期間ラジオが見つかりません")

        page.select_option('select[name="from[y]"]', str(start_d.year))
        page.select_option('select[name="from[m]"]', f"{start_d.month:02d}")
        page.select_option('select[name="from[d]"]', f"{start_d.day:02d}")
        page.select_option('select[name="to[y]"]', str(end_d.year))
        page.select_option('select[name="to[m]"]', f"{end_d.month:02d}")
        page.select_option('select[name="to[d]"]', f"{end_d.day:02d}")
        logger.info("出勤簿: 期間 指定期間 %s 〜 %s", start_d, end_d)

        # ページ下部にスクロール
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(800)

        # ダウンロード待ち最大30分 (サーバー側生成に時間がかかる場合あり)
        candidates = [
            '#download-link',
            'a:has-text("ダウンロード"):visible',
            'button:has-text("ダウンロード"):visible',
            'form[action*="down-attendance"] button[type="submit"]',
            'form[action*="down-attendance"] input[type="submit"]',
        ]

        try:
            page.screenshot(path="debug_book_before_download.png", full_page=True)
        except Exception:
            pass

        logger.info("出勤簿ダウンロード開始(最大30分待機)")
        with page.expect_download(timeout=30 * 60 * 1000) as dl_info:
            clicked = None
            for sel in candidates:
                try:
                    page.click(sel, timeout=3000)
                    clicked = sel
                    break
                except PWTimeout:
                    continue
            if not clicked:
                shot = Path("debug_book_no_button.png").resolve()
                try:
                    page.screenshot(path=str(shot), full_page=True)
                except Exception:
                    pass
                raise RuntimeError(f"出勤簿ダウンロードボタンが見つかりません。{shot} 参照。")
            logger.info("ダウンロードボタン押下: %s", clicked)

        download = dl_info.value
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        suggested = download.suggested_filename or "attendance_book.xlsx"
        ext = Path(suggested).suffix or ".xlsx"
        saved = download_dir / f"attendance_book_{start_d}_{end_d}_{timestamp}{ext}"
        download.save_as(saved)
        logger.info("出勤簿保存: %s", saved)

        browser.close()
        return saved


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    cfg = json.loads(Path("config.json").read_text(encoding="utf-8"))
    p1 = download_attendance_csv(cfg)
    print(f"勤務データCSV: {p1}")
    p2 = download_attendance_book(cfg)
    print(f"出勤簿Excel:   {p2}")
