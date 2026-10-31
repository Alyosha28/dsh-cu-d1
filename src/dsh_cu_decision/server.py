from __future__ import annotations

import argparse
import base64
import hmac
import io
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from PIL import Image

from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .policy import (
    TEXT_STRATEGIES,
    DecisionError,
    apply_text_value,
    build_questions,
    parse_decision,
    text_question_for_target,
)


MAX_REQUEST_BYTES = 1024 * 1024
MAX_VISION_WIDTH = int(os.environ.get("DSH_CU_VISION_WIDTH", "800"))


def prepare_media(image_bytes: bytes) -> list[Image.Image]:
    """Downscale wide screenshots before vision encoding; boxes stay normalized."""
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = source.convert("RGB")
    if image.width > MAX_VISION_WIDTH:
        height = max(1, round(image.height * MAX_VISION_WIDTH / image.width))
        image = image.resize((MAX_VISION_WIDTH, height), Image.LANCZOS)
    return [image]


class DecisionEngine:
    def __init__(self, model: D1Model) -> None:
        self.model = model

    def decide(self, payload: dict[str, Any]) -> dict[str, Any]:
        goal = payload.get("goal")
        observation = payload.get("observation")
        text_strategy = payload.get("textStrategy", "speculative")
        if not isinstance(goal, str) or not goal.strip():
            raise ValueError("goal must be a nonempty string")
        if not isinstance(observation, dict):
            raise ValueError("observation must be an object")
        if text_strategy not in TEXT_STRATEGIES:
            raise ValueError(f"textStrategy must be one of {TEXT_STRATEGIES}")
        inputs = payload.get("inputs")
        if inputs is not None and (
            not isinstance(inputs, dict)
            or any(not isinstance(key, str) or not isinstance(value, str) for key, value in inputs.items())
        ):
            raise ValueError("inputs must be a string-to-string object")
        structured = bool(inputs)
        media = None
        screenshot = payload.get("screenshot")
        if screenshot is not None:
            if not isinstance(screenshot, dict) or screenshot.get("mimeType") not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("screenshot must be PNG, JPEG, or WebP")
            try:
                image_bytes = base64.b64decode(screenshot["data"], validate=True)
            except Exception as error:
                raise ValueError("screenshot data must be valid base64") from error
            if len(image_bytes) > 8 * 1024 * 1024:
                raise ValueError("screenshot exceeds 8 MiB")
            media = prepare_media(image_bytes)

        state = {"goal": goal, "observation": observation}
        if structured:
            state["inputs"] = inputs
        effective_strategy = "on-demand" if structured else text_strategy
        visual = media is not None
        output, elapsed_ms = self.model.system_one(
            state, build_questions(observation, text_strategy=effective_strategy, visual=visual), media=media
        )
        decision = parse_decision(observation, output["answers"], text_strategy=effective_strategy, visual=visual)
        usage = dict(output["usage"])
        text_extraction_calls = 0
        if structured and decision["operation"] in {"TYPE_TEXT", "PASTE_TEXT"}:
            target = decision["target"]
            if visual and target is None:
                if len(inputs) != 1:
                    raise DecisionError("A visual text target requires exactly one structured input")
                key = next(iter(inputs))
            else:
                element = next(
                    (element for element in observation.get("elements", []) if str(element.get("id")) == str(target)),
                    None,
                )
                keys = [element.get("name"), element.get("identifier")] if element else []
                key = next((key for key in keys if key and key in inputs), None)
            if key is None:
                raise DecisionError(
                    f"No structured input for target {target!r}; provide inputs using its accessible name or identifier"
                )
            decision["text"] = inputs[key]
            decision["text_source"] = "structured"
        elif text_strategy == "on-demand" and decision["operation"] in {"TYPE_TEXT", "PASTE_TEXT"}:
            question = (
                {
                    "type": "text",
                    "instructions": (
                        "What exact literal text should be entered into the visual target field? "
                        "Extract only text explicitly supplied by the goal or structured inputs."
                    ),
                }
                if visual else text_question_for_target(observation, decision["target"], decision["operation"])
            )
            text_output, text_ms = self.model.system_one(
                state, {"type_text_value": question}, media=media
            )
            elapsed_ms += text_ms
            text_extraction_calls = 1
            usage["input_tokens"] += text_output["usage"]["input_tokens"]
            apply_text_value(decision, text_output["answers"]["type_text_value"])
        return {
            "decision": decision,
            "usage": usage,
            "latencyMs": elapsed_ms,
            "textExtractionCalls": text_extraction_calls,
        }


class DecisionHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], engine: DecisionEngine, token: str) -> None:
        self.engine = engine
        self.token = token
        self.inference_lock = threading.Lock()
        super().__init__(address, DecisionHandler)


class DecisionHandler(BaseHTTPRequestHandler):
    server: DecisionHttpServer

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _authorized(self) -> bool:
        expected = f"Bearer {self.server.token}"
        supplied = self.headers.get("Authorization", "")
        return hmac.compare_digest(supplied, expected)

    def _send(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        self._send(200, {
            "status": "ready",
            "model": DEFAULT_MODEL_ID,
            "revision": DEFAULT_REVISION,
            "device": self.server.engine.model.device,
        })

    def do_POST(self) -> None:
        if self.path != "/decide":
            self._send(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"error": "invalid_content_length"})
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self._send(413, {"error": "request_size_invalid"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("request body must be an object")
            with self.server.inference_lock:
                result = self.server.engine.decide(payload)
            self._send(200, result)
        except (DecisionError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self._send(400, {"error": "decision_rejected", "message": str(exc)})
        except Exception:
            self.server.logger.exception("D1 decision failed") if hasattr(self.server, "logger") else None
            self._send(500, {"error": "decision_failed"})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=None, help="Bearer token; generated when omitted")
    parser.add_argument("--local-files-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    token = args.token or secrets.token_urlsafe(32)
    model = D1Model(local_files_only=args.local_files_only)
    server = DecisionHttpServer(("127.0.0.1", args.port), DecisionEngine(model), token)
    print(f"D1 decision service: http://127.0.0.1:{args.port}", flush=True)
    print(f"D1_DECISION_TOKEN={token}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
