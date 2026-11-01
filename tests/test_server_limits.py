"""Boundaries of the local decision service: decode limits, timeouts, logging.

The service is loopback-only, but a 1 MiB request body can still name an image
of tens of millions of pixels, so the decode path is bounded separately from the
body size (SR-09).
"""

import base64
import io
import logging

import pytest
from PIL import Image

from dsh_cu_decision import server as server_module
from dsh_cu_decision.server import (
    MAX_DECODED_BYTES,
    MAX_IMAGE_PIXELS,
    REQUEST_TIMEOUT_SECONDS,
    DecisionEngine,
    prepare_media,
)


def png_bytes(width: int, height: int, mode: str = "1") -> bytes:
    """A real PNG of a huge single-color image, small on disk.

    1-bit greyscale: a 30000x30000 sheet compresses to a few kilobytes, which is
    what makes the decode amplification work.
    """
    buffer = io.BytesIO()
    Image.new(mode, (width, height)).save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def test_decode_limits_are_configured():
    assert MAX_IMAGE_PIXELS > 0
    assert Image.MAX_IMAGE_PIXELS == MAX_IMAGE_PIXELS
    assert MAX_DECODED_BYTES >= 1024 * 1024


def test_huge_png_is_rejected_before_decoding():
    payload = png_bytes(30000, 30000)
    # The exploit precondition: a tiny file that decodes far above the limit.
    assert len(payload) < 1024 * 1024
    with pytest.raises(ValueError, match="40000000-pixel decode limit"):
        prepare_media(payload)


def test_decoded_size_limit_is_enforced():
    payload = png_bytes(8, 8)
    with pytest.raises(ValueError, match="MiB"):
        prepare_media(payload + b"\0" * (MAX_DECODED_BYTES + 1))


def test_body_size_limit_is_smaller_than_the_decode_limit():
    """The old 8 MiB check sat behind a 1 MiB body cap and could never fire."""
    assert server_module.MAX_REQUEST_BYTES < MAX_DECODED_BYTES


def test_normal_screenshot_still_passes():
    payload = png_bytes(1200, 600, mode="RGB")
    media = prepare_media(payload)
    assert len(media) == 1
    assert media[0].width == server_module.MAX_VISION_WIDTH


def test_handler_has_a_socket_timeout():
    assert server_module.DecisionHandler.timeout == REQUEST_TIMEOUT_SECONDS
    assert REQUEST_TIMEOUT_SECONDS > 0


def test_server_wires_a_real_logger():
    """`DecisionHttpServer` used to set no `logger`, so the 500 path logged nothing."""
    assert server_module.DecisionHttpServer.logger is server_module.LOGGER
    assert server_module.LOGGER.name == "dsh_cu_decision.server"


class ExplodingModel:
    device = "cpu"

    def system_one(self, state, questions, media=None):
        raise RuntimeError("model exploded")


class CapturingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


class FakeServer:
    def __init__(self, engine, token: str) -> None:
        import threading

        self.engine = engine
        self.token = token
        self.logger = server_module.LOGGER
        self.inference_lock = threading.Lock()


class FakeRequest:
    """Minimal stand-in for BaseHTTPRequestHandler's request surface."""

    def __init__(self, body: bytes, headers: dict[str, str], path: str = "/decide") -> None:
        self.rfile = io.BytesIO(body)
        self.headers = headers
        self.path = path
        self.sent: list[tuple[int, dict]] = []

    def _send(self, status: int, value: dict) -> None:
        self.sent.append((status, value))


def make_handler(body: bytes, headers: dict[str, str], engine, token: str = "token"):
    handler = server_module.DecisionHandler.__new__(server_module.DecisionHandler)
    handler.rfile = io.BytesIO(body)
    handler.headers = headers
    handler.path = "/decide"
    handler.server = FakeServer(engine, token)
    handler.sent = []
    handler._send = lambda status, value: handler.sent.append((status, value))  # type: ignore[method-assign]
    return handler


def test_unexpected_failure_is_logged_and_answered():
    body = b'{"goal": "click", "observation": {"elements": []}}'
    handler = make_handler(body, {"Authorization": "Bearer token", "Content-Length": str(len(body))},
                           DecisionEngine(ExplodingModel()))
    capturing = CapturingHandler()
    server_module.LOGGER.addHandler(capturing)
    try:
        handler.do_POST()
    finally:
        server_module.LOGGER.removeHandler(capturing)

    assert handler.sent[-1] == (500, {"error": "decision_failed"})
    assert any("D1 decision failed" in message for message in capturing.messages)
    # Structural detail only: no token, no body.
    assert all("token" not in message.lower() for message in capturing.messages)


def test_unauthenticated_request_is_rejected_before_body_read():
    handler = make_handler(b"", {"Content-Length": "999999999"}, DecisionEngine(ExplodingModel()), token="secret")
    handler.do_POST()
    assert handler.sent == [(401, {"error": "unauthorized"})]


def test_oversized_body_is_refused_before_decoding():
    length = server_module.MAX_REQUEST_BYTES + 1
    handler = make_handler(b"", {"Authorization": "Bearer token", "Content-Length": str(length)},
                           DecisionEngine(ExplodingModel()))
    handler.do_POST()
    assert handler.sent == [(413, {"error": "request_size_invalid"})]


def test_huge_screenshot_in_a_small_body_is_a_400_not_a_500():
    payload = png_bytes(30000, 30000)
    body = (
        b'{"goal": "click", "observation": {}, "screenshot": {"mimeType": "image/png", "data": "'
        + base64.b64encode(payload)
        + b'"}}'
    )
    handler = make_handler(body, {"Authorization": "Bearer token", "Content-Length": str(len(body))},
                           DecisionEngine(ExplodingModel()))
    handler.do_POST()
    status, value = handler.sent[-1]
    assert status == 400
    assert "decode limit" in value["message"]
