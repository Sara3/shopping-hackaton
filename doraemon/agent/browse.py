"""Doraemon's page reader for listing links the user shares (the demo's inspiration pages).

Same allow-list as the naive agent's reader (../agent/browse.mjs): only the Arcade replica's
/inspo/ listings and the public static copy named by BROWSE_ORIGINS (pages under
BROWSE_PATH_PREFIX, default /odette-atelier/). Every other URL is refused before any request.

Unlike the naive reader, text a human can't see -- HTML comments and elements styled away
(display:none, visibility:hidden, 1px fonts, white-on-white) -- never reaches the model. It is
returned separately as `hidden_text` so the trace can show what the page tried to say
(agent_constitution.md Section 2: guard against prompt injection carried in pages).
"""

from __future__ import annotations

import html as html_lib
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit

REPLICA_PATH_PREFIX = "/inspo/"
DEFAULT_EXTRA_PATH_PREFIX = "/odette-atelier/"
DEFAULT_MOCK_PORT = 8788
MAX_PAGE_BYTES = 256 * 1024
FETCH_TIMEOUT_SECONDS = 5
_USER_AGENT = "doraemon-browse/0.1"

_DROPPED_BLOCKS = re.compile(r"<(script|style)\b[^>]*>[\s\S]*?</\1\s*>", re.IGNORECASE)
_COMMENT = re.compile(r"<!--([\s\S]*?)-->")
_TAG = re.compile(r"<[/!a-zA-Z][^>]*>")
_TITLE = re.compile(r"<title[^>]*>([\s\S]*?)</title>", re.IGNORECASE)
_TITLE_SUFFIX = re.compile(r"\s+\|\s+[^|]*$")
_OPEN_TAG = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>")
_STYLE_ATTRIBUTE = re.compile(r"""\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE)
_VOID_TAGS = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"})
_HIDING_STYLES = (
    re.compile(r"font-size:\s*0*1px", re.IGNORECASE),
    re.compile(r"display:\s*none", re.IGNORECASE),
    re.compile(r"visibility:\s*hidden", re.IGNORECASE),
)
# "color:" must not be the tail of "background-color:", or any white card would count as hidden.
_WHITE_TEXT = re.compile(r"(?<![-\w])color:\s*#(?:fff|ffffff)\b", re.IGNORECASE)
_WHITE_BACKGROUND = re.compile(r"background(?:-color)?:\s*#(?:fff|ffffff)\b", re.IGNORECASE)


def _plain(fragment: str) -> str:
    return re.sub(r"\s+", " ", html_lib.unescape(_TAG.sub(" ", fragment))).strip()


def _is_hidden_style(style: str) -> bool:
    return any(p.search(style) for p in _HIDING_STYLES) or bool(_WHITE_TEXT.search(style) and _WHITE_BACKGROUND.search(style))


def _inner_end(source: str, tag: str, start: int) -> int | None:
    """Index where the element opened just before `start` closes, counting nested same-name tags."""
    depth = 1
    for token in re.compile(rf"<(/?){tag}\b[^>]*>", re.IGNORECASE).finditer(source, start):
        depth += -1 if token.group(1) else 1
        if depth == 0:
            return token.start()
    return None


def _hidden_spans(source: str) -> list[tuple[int, int, int]]:
    """(element start, inner start, inner end) of each top-level element styled out of sight."""
    spans: list[tuple[int, int, int]] = []
    consumed_until = 0
    for match in _OPEN_TAG.finditer(source):
        tag = match.group(1).lower()
        style = _STYLE_ATTRIBUTE.search(match.group(2))
        if match.start() < consumed_until or tag in _VOID_TAGS or not style:
            continue
        if not _is_hidden_style(style.group(1) or style.group(2) or ""):
            continue
        end = _inner_end(source, tag, match.end())
        if end is None:
            continue
        spans.append((match.start(), match.end(), end))
        consumed_until = end
    return spans


def extract_page(source: str) -> dict:
    """{title, text, hidden_text}: `text` is only what a person sees; `hidden_text` is every hidden
    element and comment, in document order, tags stripped, duplicates dropped."""
    title_match = _TITLE.search(source)
    title = _TITLE_SUFFIX.sub("", _plain(title_match.group(1))) if title_match else ""
    body = _DROPPED_BLOCKS.sub(" ", source)
    fragments = [(m.start(), m.group(1)) for m in _COMMENT.finditer(body)]
    spans = _hidden_spans(body)
    fragments += [(start, body[inner_start:inner_end]) for start, inner_start, inner_end in spans]
    hidden: list[str] = []
    for _, fragment in sorted(fragments):
        text = _plain(fragment)
        if text and text not in hidden:
            hidden.append(text)
    visible = body
    for start, _inner_start, inner_end in reversed(spans):
        visible = visible[:start] + " " + visible[inner_end:]
    visible = _COMMENT.sub(" ", visible)
    return {"title": title, "text": _plain(visible), "hidden_text": hidden}


def _allowed_prefixes() -> list[tuple[str, str]]:
    port = int(os.getenv("MOCK_PORT") or DEFAULT_MOCK_PORT)
    allowed = [(f"http://localhost:{port}", REPLICA_PATH_PREFIX), (f"http://127.0.0.1:{port}", REPLICA_PATH_PREFIX)]
    prefix = "/" + (os.getenv("BROWSE_PATH_PREFIX") or DEFAULT_EXTRA_PATH_PREFIX).strip().strip("/") + "/"
    for raw in (os.getenv("BROWSE_ORIGINS") or "").split(","):
        parts = urlsplit(raw.strip())
        if parts.scheme in ("http", "https") and parts.netloc:
            allowed.append((f"{parts.scheme}://{parts.netloc}", prefix))
    return allowed


def is_browsable(url: str) -> bool:
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    return any(origin == allowed and parts.path.startswith(prefix) for allowed, prefix in _allowed_prefixes())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # a redirect could leave the allow-list
        return None


def fetch_page(url: str) -> dict:
    """Fetches one allow-listed listing page. Returns {url, title, text, hidden_text} or {error}."""
    if not is_browsable(url):
        allowed = ", ".join(f"{origin}{prefix}" for origin, prefix in _allowed_prefixes())
        return {"error": f"browse only reads listing pages under: {allowed}"}
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "text/html"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return {"error": f"browse: HTTP {response.status} for {url}"}
            content_type = response.headers.get("Content-Type", "")
            if not content_type.lower().startswith("text/html"):
                return {"error": f"browse: {url} is not an HTML page ({content_type or 'no content-type'})"}
            source = response.read(MAX_PAGE_BYTES).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return {"error": f"browse: HTTP {exc.code} for {url}"}
    except OSError as exc:
        return {"error": f"browse: could not read {url}: {getattr(exc, 'reason', exc)}"}
    return {"url": url, **extract_page(source)}
