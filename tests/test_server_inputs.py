import base64
import io

import pytest
from PIL import Image

from dsh_cu_decision.policy import DecisionError
from dsh_cu_decision.server import MAX_VISION_WIDTH, DecisionEngine, prepare_media


class FakeModel:
    device = "cpu"

    def system_one(self, state, questions, media=None):
        return {
            "answers": {
                "operation": {"choice": "TYPE_TEXT", "confidence": 0.9, "probabilities": {}},
                "type_text_target": {"choice": "1", "confidence": 0.99, "probabilities": {}},
            },
            "usage": {"input_tokens": 10, "output_tokens": 0},
        }, 1.0


class PasteModel(FakeModel):
    def system_one(self, state, questions, media=None):
        return {
            "answers": {
                "operation": {"choice": "PASTE_TEXT", "confidence": 0.9, "probabilities": {}},
                "paste_text_target": {"choice": "1", "confidence": 0.99, "probabilities": {}},
            },
            "usage": {"input_tokens": 10, "output_tokens": 0},
        }, 1.0


class VisualPasteModel(FakeModel):
    def system_one(self, state, questions, media=None):
        return {
            "answers": {
                "operation": {"choice": "PASTE_TEXT", "confidence": 0.9, "probabilities": {}},
                "visual_target": {
                    "box": {"left": 0.1, "right": 0.9, "top": 0.3, "bottom": 0.8},
                    "found": 1.0, "confidence": 0.99,
                },
            },
            "usage": {"input_tokens": 10, "output_tokens": 0},
        }, 1.0


def observation():
    return {
        "elements": [{
            "id": "1", "role": "AXTextField", "name": "Report path",
            "identifier": "dsh-workflow-path", "value": "", "actions": ["type"], "enabled": True,
        }]
    }


def test_structured_inputs_bypass_model_text_extraction():
    engine = DecisionEngine(FakeModel())
    result = engine.decide({
        "goal": "Import report",
        "observation": observation(),
        "inputs": {"Report path": "/tmp/report.csv"},
        "textStrategy": "speculative",
    })
    assert result["decision"]["text"] == "/tmp/report.csv"
    assert result["decision"]["text_source"] == "structured"
    assert result["textExtractionCalls"] == 0


def test_structured_inputs_supply_native_paste_without_model_text_extraction():
    engine = DecisionEngine(PasteModel())
    native_observation = observation()
    native_observation["elements"][0]["actions"] = ["paste"]
    result = engine.decide({
        "goal": "Enter the document body",
        "observation": native_observation,
        "inputs": {"Report path": "Literal document body"},
        "textStrategy": "speculative",
    })
    assert result["decision"]["operation"] == "PASTE_TEXT"
    assert result["decision"]["text"] == "Literal document body"
    assert result["decision"]["text_source"] == "structured"
    assert result["textExtractionCalls"] == 0


def screenshot():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(buffer, format="PNG")
    return {"data": base64.b64encode(buffer.getvalue()).decode(), "mimeType": "image/png"}


def test_visual_paste_uses_one_unambiguous_structured_input():
    engine = DecisionEngine(VisualPasteModel())
    payload = {
        "goal": "Enter the document body",
        "observation": {"url": "app://1/2", "elements": []},
        "inputs": {"Body": "Literal document body"},
        "screenshot": screenshot(),
    }
    result = engine.decide(payload)
    assert result["decision"]["operation"] == "PASTE_TEXT"
    assert result["decision"]["target"] is None
    assert result["decision"]["text"] == "Literal document body"
    assert result["textExtractionCalls"] == 0
    payload["inputs"]["Other"] = "Ambiguous"
    with pytest.raises(DecisionError, match="exactly one structured input"):
        engine.decide(payload)


def test_missing_structured_input_fails_before_action():
    engine = DecisionEngine(FakeModel())
    with pytest.raises(DecisionError, match="No structured input"):
        engine.decide({
            "goal": "Import report",
            "observation": observation(),
            "inputs": {"Other field": "/tmp/other.csv"},
        })


def test_wide_screenshot_is_downscaled_before_vision_encoding():
    buffer = io.BytesIO()
    Image.new("RGB", (2508, 1671), "white").save(buffer, format="PNG")
    media = prepare_media(buffer.getvalue())
    assert len(media) == 1
    assert media[0].width == MAX_VISION_WIDTH
    assert media[0].height == round(1671 * MAX_VISION_WIDTH / 2508)


def test_narrow_screenshot_keeps_its_pixels():
    buffer = io.BytesIO()
    Image.new("RGB", (640, 400), "white").save(buffer, format="PNG")
    media = prepare_media(buffer.getvalue())
    assert (media[0].width, media[0].height) == (640, 400)
