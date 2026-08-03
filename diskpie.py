#!/usr/bin/env python3
"""DiskPie — Windows 磁碟空間圓餅圖檢視工具。

只用 Python 標準函式庫：後端負責掃描資料夾大小，前端是本機網頁（圓餅圖 + 表格），
點選任一資料夾即可往下展開，看到該層所有子目錄與各自占用的容量。

用法：
    python diskpie.py              # 開啟介面，於畫面上選擇要掃描的磁碟
    python diskpie.py C:\\          # 開啟介面並直接開始掃描 C:\\
    python diskpie.py --port 8777  # 指定連接埠
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import secrets
import shutil
import string
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

FILE_ATTRIBUTE_REPARSE_POINT = 0x400
LONG_PREFIX = "\\\\?\\"
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
MAX_DEPTH = 160          # 保險用的遞迴深度上限
FLUSH_EVERY = 200        # 每掃幾個目錄回報一次進度
WORKERS = 8              # 第一層子目錄的平行掃描執行緒數
TOP_FILES = 15           # 每層列出的大檔數量

TOKEN = secrets.token_urlsafe(16)


# --------------------------------------------------------------------------
# 掃描核心
# --------------------------------------------------------------------------

class Node:
    """一個資料夾。只存名字，完整路徑由樹狀結構往下拼出來（省記憶體）。"""

    __slots__ = ("name", "size", "own_size", "file_count", "children", "denied")

    def __init__(self, name: str) -> None:
        self.name = name
        self.size = 0            # 含所有子目錄的總計
        self.own_size = 0        # 只算本層的檔案
        self.file_count = 0      # 本層檔案數
        self.children: dict[str, "Node"] = {}   # key 為小寫名稱（Windows 不分大小寫）
        self.denied = False      # 無權限或讀取失敗


class Counters:
    """每個執行緒各自累計，湊滿一批才寫回共用狀態，避免頻繁上鎖。"""

    __slots__ = ("dirs", "files", "size", "errors", "pending", "current")

    def __init__(self) -> None:
        self.reset()
        self.current = ""

    def reset(self) -> None:
        self.dirs = self.files = self.size = self.errors = self.pending = 0

    def maybe_flush(self, scanner: "Scanner") -> None:
        self.pending += 1
        if self.pending >= FLUSH_EVERY:
            self.flush(scanner)

    def flush(self, scanner: "Scanner") -> None:
        with scanner.lock:
            scanner.dirs += self.dirs
            scanner.files += self.files
            scanner.size += self.size
            scanner.errors += self.errors
            if self.current:
                scanner.current = self.current
        self.reset()


def _phys(path: str) -> str:
    """加上 \\\\?\\ 前綴，讓 scandir 能處理超過 260 字元的路徑。"""
    if path.startswith(LONG_PREFIX) or path.startswith("\\\\"):
        return path
    return LONG_PREFIX + path


def _display(path: str) -> str:
    return path[len(LONG_PREFIX):] if path.startswith(LONG_PREFIX) else path


class Scanner:
    """負責掃一整棵樹，並提供查詢 / 局部重掃。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.root = ""
        self.tree: Node | None = None
        self.state = "idle"      # idle / scanning / done / cancelled / error
        self.message = ""
        self.dirs = self.files = self.size = self.errors = 0
        self.current = ""
        self.started = 0.0
        self.elapsed = 0.0
        self._thread: threading.Thread | None = None

    # -- 掃描 ---------------------------------------------------------------

    def _scan_one(self, node: Node, path: str, c: Counters) -> list[tuple[Node, str]]:
        """掃單一目錄：累計本層檔案，回傳待遞迴的子目錄。"""
        subdirs: list[tuple[Node, str]] = []
        own = 0
        fcount = 0
        try:
            it = os.scandir(path)
        except OSError:
            node.denied = True
            c.errors += 1
            c.dirs += 1
            return subdirs

        with it:
            while True:
                try:
                    entry = next(it)
                except StopIteration:
                    break
                except OSError:
                    c.errors += 1
                    break
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    c.errors += 1
                    continue
                # 捷徑/junction/OneDrive 雲端佔位不追進去，避免重複計算與無限迴圈
                if getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    c.errors += 1
                    continue
                if is_dir:
                    child = Node(entry.name)
                    node.children[entry.name.lower()] = child
                    subdirs.append((child, entry.path))
                else:
                    own += st.st_size
                    fcount += 1

        node.own_size = own
        node.file_count = fcount
        c.dirs += 1
        c.files += fcount
        c.size += own
        c.current = _display(path)
        c.maybe_flush(self)
        return subdirs

    def _walk(self, node: Node, path: str, depth: int, c: Counters) -> None:
        if self.cancel.is_set() or depth > MAX_DEPTH:
            node.size = node.own_size
            return
        subdirs = self._scan_one(node, path, c)
        total = node.own_size
        for child, cpath in subdirs:
            self._walk(child, cpath, depth + 1, c)
            total += child.size
        node.size = total

    def _walk_parallel(self, node: Node, path: str, c0: Counters) -> None:
        """根目錄的第一層子目錄分給多個執行緒跑，掃整顆磁碟時快很多。"""
        queue = self._scan_one(node, path, c0)
        c0.flush(self)
        qlock = threading.Lock()

        def worker() -> None:
            c = Counters()
            while not self.cancel.is_set():
                with qlock:
                    if not queue:
                        break
                    child, cpath = queue.pop()
                self._walk(child, cpath, 1, c)
            c.flush(self)

        threads = [threading.Thread(target=worker, daemon=True)
                   for _ in range(min(WORKERS, max(1, len(queue))))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        node.size = node.own_size + sum(ch.size for ch in node.children.values())

    def start(self, path: str) -> tuple[bool, str]:
        if self.state == "scanning":
            return False, "已經有掃描在進行中"
        path = os.path.abspath(path)
        if not os.path.isdir(path):
            return False, f"找不到資料夾：{path}"

        self.cancel.clear()
        with self.lock:
            self.root = path
            self.tree = None
            self.state = "scanning"
            self.message = ""
            self.dirs = self.files = self.size = self.errors = 0
            self.current = path
            self.started = time.time()
            self.elapsed = 0.0

        def run() -> None:
            try:
                tree = Node(path)
                self._walk_parallel(tree, _phys(path), Counters())
                with self.lock:
                    self.tree = tree
                    self.elapsed = time.time() - self.started
                    self.state = "cancelled" if self.cancel.is_set() else "done"
                    self.current = ""
            except Exception as exc:                     # noqa: BLE001 — 回報給前端
                with self.lock:
                    self.state = "error"
                    self.message = f"{type(exc).__name__}: {exc}"

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()
        return True, ""

    def rescan(self, path: str) -> tuple[bool, str]:
        """重新掃描某個子資料夾（例如剛剛刪完檔案），並修正所有上層的大小。"""
        chain = self.find_chain(path)
        if chain is None:
            return False, "此路徑不在目前的掃描結果中"
        target = chain[-1]
        old_size = target.size

        with self.lock:
            self.state = "scanning"
            self.dirs = self.files = self.size = self.errors = 0
            self.started = time.time()
            self.current = path

        fresh = Node(target.name)
        if os.path.isdir(path):
            self._walk(fresh, _phys(path), 0, Counters())
        else:
            fresh.size = 0                                # 資料夾已被刪除

        with self.lock:
            if len(chain) == 1:
                self.tree = fresh
            else:
                parent = chain[-2]
                key = target.name.lower()
                if os.path.isdir(path):
                    parent.children[key] = fresh
                else:
                    parent.children.pop(key, None)
            delta = fresh.size - old_size
            for node in chain[:-1]:
                node.size += delta
            self.state = "done"
            self.current = ""
            self.elapsed = time.time() - self.started
        return True, ""

    # -- 查詢 ---------------------------------------------------------------

    def find_chain(self, path: str) -> list[Node] | None:
        """回傳從根到目標的節點串列（含兩端）；找不到就 None。"""
        if self.tree is None:
            return None
        path = os.path.abspath(path)
        try:
            rel = os.path.relpath(path, self.root)
        except ValueError:
            return None
        chain = [self.tree]
        if rel in (".", ""):
            return chain
        if rel.startswith(".."):
            return None
        node = self.tree
        for part in rel.split(os.sep):
            nxt = node.children.get(part.lower())
            if nxt is None:
                return None
            chain.append(nxt)
            node = nxt
        return chain

    def view(self, path: str) -> dict | None:
        chain = self.find_chain(path)
        if chain is None:
            return None
        node = chain[-1]
        path = os.path.abspath(path)

        children = [
            {
                "name": ch.name,
                "path": os.path.join(path, ch.name),
                "size": ch.size,
                "subdirs": len(ch.children),
                "files": ch.file_count,
                "denied": ch.denied,
                "drillable": bool(ch.children) or ch.file_count > 0,
            }
            for ch in node.children.values()
        ]
        children.sort(key=lambda d: -d["size"])

        # 麵包屑：從根一路到目前位置
        crumbs = []
        acc = self.root
        crumbs.append({"name": self.root, "path": self.root})
        if len(chain) > 1:
            for ch in chain[1:]:
                acc = os.path.join(acc, ch.name)
                crumbs.append({"name": ch.name, "path": acc})

        return {
            "root": self.root,
            "path": path,
            "name": node.name if len(chain) > 1 else self.root,
            "size": node.size,
            "ownSize": node.own_size,
            "fileCount": node.file_count,
            "denied": node.denied,
            "parent": os.path.dirname(path.rstrip(os.sep)) if len(chain) > 1 else None,
            "breadcrumb": crumbs,
            "children": children,
            "files": self._top_files(path),
        }

    @staticmethod
    def _top_files(path: str) -> list[dict]:
        """現場列出本層最大的幾個檔案（不佔記憶體，需要時才讀）。"""
        out: list[dict] = []
        try:
            with os.scandir(_phys(path)) as it:
                for entry in it:
                    try:
                        st = entry.stat(follow_symlinks=False)
                        if getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
                    out.append({"name": entry.name, "size": st.st_size})
        except OSError:
            return []
        out.sort(key=lambda d: -d["size"])
        return out[:TOP_FILES]

    def status(self) -> dict:
        with self.lock:
            elapsed = self.elapsed if self.state in ("done", "cancelled", "error") \
                else (time.time() - self.started if self.started else 0.0)
            return {
                "state": self.state,
                "root": self.root,
                "dirs": self.dirs,
                "files": self.files,
                "size": self.size,
                "errors": self.errors,
                "current": self.current,
                "elapsed": round(elapsed, 1),
                "ready": self.tree is not None,
            }


SCANNER = Scanner()


# --------------------------------------------------------------------------
# 磁碟清單
# --------------------------------------------------------------------------

DRIVE_TYPES = {2: "抽取式", 3: "本機磁碟", 4: "網路磁碟", 5: "光碟機", 6: "RAM 磁碟"}


def list_drives() -> list[dict]:
    drives: list[dict] = []
    kernel32 = ctypes.windll.kernel32
    mask = kernel32.GetLogicalDrives()
    for i, letter in enumerate(string.ascii_uppercase):
        if not (mask >> i) & 1:
            continue
        root = f"{letter}:\\"
        dtype = kernel32.GetDriveTypeW(ctypes.c_wchar_p(root))
        if dtype not in (2, 3, 6):          # 只列本機（含抽取式），略過網路與光碟
            continue
        try:
            usage = shutil.disk_usage(root)
        except OSError:                      # 沒有插入媒體
            continue
        label = ""
        buf = ctypes.create_unicode_buffer(261)
        fs = ctypes.create_unicode_buffer(261)
        try:
            if kernel32.GetVolumeInformationW(ctypes.c_wchar_p(root), buf, 261,
                                              None, None, None, fs, 261):
                label = buf.value
        except OSError:
            pass
        drives.append({
            "path": root,
            "label": label,
            "kind": DRIVE_TYPES.get(dtype, "磁碟"),
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
        })
    return drives


# --------------------------------------------------------------------------
# HTTP 介面（只綁 127.0.0.1，且 /api/* 需要啟動時產生的權杖）
# --------------------------------------------------------------------------

CONTENT_TYPES = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    server_version = "DiskPie"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:      # 不要把每個請求都印到主控台
        pass

    # -- 工具 ---------------------------------------------------------------

    def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8", code)

    def _authed(self) -> bool:
        return self.headers.get("X-DiskPie-Token") == TOKEN

    def _static(self, name: str) -> None:
        safe = os.path.basename(name)
        full = os.path.join(WEB_DIR, safe)
        if not os.path.isfile(full):
            self._send(b"not found", "text/plain; charset=utf-8", 404)
            return
        ctype = CONTENT_TYPES.get(os.path.splitext(safe)[1], "application/octet-stream")
        with open(full, "rb") as fh:
            self._send(fh.read(), ctype)

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            return {}

    # -- 路由 ---------------------------------------------------------------

    def do_GET(self) -> None:                  # noqa: N802
        url = urlparse(self.path)
        path, query = url.path, parse_qs(url.query)

        if path in ("/", "/index.html"):
            self._static("index.html")
            return
        if path.startswith("/static/"):
            self._static(path[len("/static/"):])
            return
        if path == "/token":                   # 前端啟動時取權杖（同源才拿得到）
            self._json({"token": TOKEN})
            return

        if not path.startswith("/api/"):
            self._send(b"not found", "text/plain; charset=utf-8", 404)
            return
        if not self._authed():
            self._json({"error": "unauthorized"}, 403)
            return

        if path == "/api/drives":
            self._json({"drives": list_drives(), "start": START_PATH})
        elif path == "/api/status":
            self._json(SCANNER.status())
        elif path == "/api/node":
            target = (query.get("path") or [""])[0]
            if SCANNER.tree is None:
                self._json({"error": "尚未完成掃描"}, 409)
                return
            view = SCANNER.view(target or SCANNER.root)
            if view is None:
                self._json({"error": "找不到此路徑"}, 404)
                return
            self._json(view)
        else:
            self._json({"error": "unknown endpoint"}, 404)

    def do_POST(self) -> None:                 # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            self._send(b"not found", "text/plain; charset=utf-8", 404)
            return
        if not self._authed():
            self._json({"error": "unauthorized"}, 403)
            return

        data = self._body()
        target = str(data.get("path") or "")

        if path == "/api/scan":
            ok, msg = SCANNER.start(target)
            self._json({"ok": ok, "error": msg}, 200 if ok else 400)
        elif path == "/api/cancel":
            SCANNER.cancel.set()
            self._json({"ok": True})
        elif path == "/api/rescan":
            ok, msg = SCANNER.rescan(target)
            self._json({"ok": ok, "error": msg}, 200 if ok else 400)
        elif path == "/api/open":
            try:
                os.startfile(target)           # 用檔案總管開啟資料夾
                self._json({"ok": True})
            except OSError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
        else:
            self._json({"error": "unknown endpoint"}, 404)


START_PATH = ""


def main() -> int:
    global START_PATH

    parser = argparse.ArgumentParser(description="DiskPie — 磁碟空間圓餅圖")
    parser.add_argument("path", nargs="?", default="", help="啟動時直接掃描的磁碟或資料夾")
    parser.add_argument("--port", type=int, default=0, help="指定連接埠（預設自動挑一個）")
    parser.add_argument("--no-browser", action="store_true", help="不要自動開啟瀏覽器")
    args = parser.parse_args()

    if os.name != "nt":
        print("DiskPie 是為 Windows 設計的（用到磁碟機代號與檔案總管）。", file=sys.stderr)
    if not os.path.isdir(WEB_DIR):
        print(f"找不到網頁檔案資料夾：{WEB_DIR}", file=sys.stderr)
        return 1

    START_PATH = os.path.abspath(args.path) if args.path else ""
    if START_PATH and not os.path.isdir(START_PATH):
        print(f"找不到資料夾：{START_PATH}", file=sys.stderr)
        return 1

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    print("DiskPie 已啟動")
    print(f"  介面： {url}")
    print("  關閉： 在這個視窗按 Ctrl+C")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已關閉。")
    finally:
        SCANNER.cancel.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
