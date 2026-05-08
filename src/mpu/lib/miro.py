"""Тонкий клиент Miro REST API v2.

Используется только из mpu-d2-miro. Намеренно без новых зависимостей —
urllib из stdlib + json. С rate-limit retry на 429.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

API_BASE = "https://api.miro.com"


@dataclass
class FrameRef:
    id: str
    title: str
    x: float  # center
    y: float
    w: float
    h: float


class MiroClient:
    def __init__(self, token: str, board_id_raw: str):
        self.token = token
        self.board_id = quote(board_id_raw, safe="")
        self.base = f"{API_BASE}/v2/boards/{self.board_id}"

    def _request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        url = f"{self.base}{path}" if path.startswith("/") else f"{API_BASE}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"

        backoff = 1.0
        for _ in range(6):
            req = Request(url, data=data, method=method, headers=headers)
            try:
                with urlopen(req) as r:
                    txt = r.read().decode("utf-8")
                    return json.loads(txt) if txt else {}
            except HTTPError as e:
                err_body = e.read().decode("utf-8", "replace")
                if e.code == 429:
                    wait = int(e.headers.get("Retry-After", str(int(backoff))))
                    print(f"[miro] 429 rate-limit, sleep {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    backoff = min(backoff * 2, 30)
                    continue
                raise MiroAPIError(method, path, e.code, err_body) from None
        raise MiroAPIError(method, path, 429, "exhausted retries")

    # ---------- frames ----------

    def list_frames(self) -> list[FrameRef]:
        out: list[FrameRef] = []
        cursor: str | None = None
        while True:
            qs = "?limit=50" + (f"&cursor={cursor}" if cursor else "")
            res = self._request("GET", f"/items{qs}&type=frame")
            for it in res.get("data", []):
                if it.get("type") != "frame":
                    continue
                pos = it.get("position", {}) or {}
                geo = it.get("geometry", {}) or {}
                title = ((it.get("data") or {}).get("title")) or ""
                out.append(
                    FrameRef(
                        id=it["id"],
                        title=title,
                        x=float(pos.get("x", 0)),
                        y=float(pos.get("y", 0)),
                        w=float(geo.get("width", 0)),
                        h=float(geo.get("height", 0)),
                    )
                )
            cursor = res.get("cursor")
            if not cursor:
                break
        return out

    def find_frame_by_title(self, title: str) -> FrameRef | None:
        for f in self.list_frames():
            if f.title == title:
                return f
        return None

    def rightmost_frame_edge(self) -> tuple[float, float]:
        """Возвращает (max_right_x, средний_y) всех существующих фреймов.
        Если фреймов нет, возвращает (0, 0)."""
        frames = self.list_frames()
        if not frames:
            return 0.0, 0.0
        right = max(f.x + f.w / 2 for f in frames)
        avg_y = sum(f.y for f in frames) / len(frames)
        return right, avg_y

    def unlock_item(self, item_id: str) -> None:
        """Снять lock с item'а через PATCH. На lock-able элементах работает безопасно;
        на уже-разлоченных тоже не бросает (Miro возвращает 200)."""
        try:
            self._request("PATCH", f"/items/{item_id}", {"locked": False})
        except MiroAPIError as e:
            # 404 — item уже удалён; 400 — на некоторых типах PATCH не поддерживается
            if e.status not in (400, 404):
                raise

    def delete_frame(self, frame_id: str) -> None:
        """Удаляет фрейм со всем содержимым.

        Miro не удаляет children при `DELETE /frames/{id}` — они остаются на доске
        как orphan-элементы. Поэтому сначала собираем всех children через
        /items?parent_item_id=... и удаляем их, потом сам фрейм.

        Залоченные элементы и сам залоченный фрейм автоматически разлочиваются перед
        удалением (lock в Miro REST API виден как поле items.locked, переключается
        через PATCH /items/{id}).
        """
        for item_id, _item_type in self._iter_children(frame_id):
            try:
                self._request("DELETE", f"/items/{item_id}")
            except MiroAPIError as e:
                if e.status == 404:
                    continue
                if e.status == 400 and "locked" in e.body.lower():
                    self.unlock_item(item_id)
                    try:
                        self._request("DELETE", f"/items/{item_id}")
                    except MiroAPIError as e2:
                        if e2.status != 404:
                            raise
                    continue
                raise
        try:
            self._request("DELETE", f"/frames/{frame_id}")
        except MiroAPIError as e:
            if e.status == 404:
                return
            if e.status == 400 and "locked" in e.body.lower():
                self.unlock_item(frame_id)
                try:
                    self._request("DELETE", f"/frames/{frame_id}")
                except MiroAPIError as e2:
                    if e2.status == 404:
                        return
                    raise
                return
            raise

    def _iter_children(self, frame_id: str) -> list[tuple[str, str]]:
        """Возвращает список (item_id, item_type) для всех элементов внутри фрейма."""
        out: list[tuple[str, str]] = []
        cursor: str | None = None
        while True:
            qs = f"?parent_item_id={frame_id}&limit=50"
            if cursor:
                qs += f"&cursor={cursor}"
            res = self._request("GET", f"/items{qs}")
            for it in res.get("data", []) or []:
                out.append((it["id"], it.get("type", "")))
            cursor = (res.get("cursor") or "") or None
            if not cursor:
                break
        return out

    @staticmethod
    def _delete_endpoint_for(item_type: str) -> str:
        # Большинство типов — общий /items/{id}, но shape/connector/text/sticky_note и
        # frame имеют типизированные эндпоинты. /items/{id} безопаснее.
        return "/items"

    def create_frame(
        self, *, title: str, x: float, y: float, width: float, height: float
    ) -> FrameRef:
        body = {
            "data": {"title": title, "format": "custom", "type": "freeform"},
            "style": {"fillColor": "#ffffff"},
            "position": {"x": x, "y": y},
            "geometry": {"width": width, "height": height},
        }
        res = self._request("POST", "/frames", body)
        return FrameRef(id=res["id"], title=title, x=x, y=y, w=width, h=height)

    # ---------- shapes / connectors / texts ----------

    def create_shape(
        self,
        *,
        parent_id: str,
        kind: str,
        content_html: str,
        x: float,
        y: float,
        width: float,
        height: float,
        fill: str = "#ffffff",
        fill_opacity: str = "1.0",
        border_color: str = "#1a1a1a",
        border_width: str = "1",
        border_style: str = "normal",
        font_size: str = "12",
        text_align: str = "center",
        text_align_vertical: str = "middle",
    ) -> str:
        body = {
            "data": {"shape": kind, "content": content_html},
            "style": {
                "fillColor": fill,
                "fillOpacity": fill_opacity,
                "borderColor": border_color,
                "borderWidth": border_width,
                "borderStyle": border_style,
                "color": "#1a1a1a",
                "fontSize": font_size,
                "textAlign": text_align,
                "textAlignVertical": text_align_vertical,
            },
            "position": {"x": x, "y": y},
            "geometry": {"width": max(width, 60), "height": max(height, 40)},
            "parent": {"id": parent_id},
        }
        res = self._request("POST", "/shapes", body)
        return res["id"]

    def create_card(
        self,
        *,
        parent_id: str,
        title: str,
        description: str,
        x: float,
        y: float,
        width: float,
        height: float,
        theme: str = "#2d9bf0",
    ) -> str:
        """Создать Miro card. Description поддерживает ограниченный HTML
        (p/strong/em/ul/li/br). theme = hex цвет «полоски» слева у card."""
        # Miro REST API требует width >= 256 для cards (валидация на сервере).
        body: dict[str, Any] = {
            "data": {"title": title, "description": description},
            "style": {"cardTheme": theme},
            "position": {"x": x, "y": y},
            "geometry": {"width": max(width, 256), "height": max(height, 40)},
            "parent": {"id": parent_id},
        }
        res = self._request("POST", "/cards", body)
        return res["id"]

    def create_text(
        self,
        *,
        parent_id: str,
        content_html: str,
        x: float,
        y: float,
        width: float,
    ) -> str:
        body = {
            "data": {"content": content_html},
            "position": {"x": x, "y": y},
            "geometry": {"width": max(width, 200)},
            "parent": {"id": parent_id},
        }
        res = self._request("POST", "/texts", body)
        return res["id"]

    def create_connector(
        self,
        *,
        src_id: str,
        dst_id: str,
        label: str = "",
        shape: str = "elbowed",
        snap_start: str | None = None,
        snap_end: str | None = None,
    ) -> str:
        """Создать connector. snap_start/snap_end ∈ {top, bottom, left, right, auto}.

        Полезно при bidirectional парах (A→B и B→A): одной паре указать `top`,
        другой — `bottom`, чтобы линии не накладывались.
        """
        start_item: dict[str, Any] = {"id": src_id}
        end_item: dict[str, Any] = {"id": dst_id}
        if snap_start:
            start_item["snapTo"] = snap_start
        if snap_end:
            end_item["snapTo"] = snap_end
        body: dict[str, Any] = {
            "startItem": start_item,
            "endItem": end_item,
            "shape": shape,
            "style": {"strokeColor": "#1a1a1a", "strokeWidth": "1"},
        }
        if label:
            body["captions"] = [{"content": label}]
        res = self._request("POST", "/connectors", body)
        return res["id"]


class MiroAPIError(Exception):
    def __init__(self, method: str, path: str, status: int, body: str):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        super().__init__(f"miro {method} {path} -> {status}: {body[:300]}")
