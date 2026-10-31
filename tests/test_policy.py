import pytest

from dsh_cu_decision.policy import (
    DecisionError,
    apply_text_value,
    build_questions,
    parse_decision,
    text_question_for_target,
)


def choice(name, confidence=0.8):
    return {"choice": name, "confidence": confidence, "probabilities": {name: confidence}}


def state():
    return {
        "can_scroll_down": True,
        "elements": [
            {"id": "field", "role": "textbox", "name": "Destination", "actions": ["click", "type"]},
            {"id": "disabled", "role": "button", "name": "Save", "enabled": False, "actions": ["click"]},
            {"id": "search", "role": "button", "name": "Search", "actions": ["click"]},
        ],
    }


def test_speculative_heads_only_contain_compatible_targets():
    questions = build_questions(state())
    assert set(questions) == {
        "operation", "click_target", "type_text_target", "type_text_value__field"
    }
    assert set(questions["click_target"]["criteria"]) == {"field", "search"}
    assert set(questions["type_text_target"]["criteria"]) == {"field"}
    assert "disabled" not in questions["click_target"]["criteria"]


def test_on_demand_defers_text_until_target_is_known():
    observation = state()
    questions = build_questions(observation, text_strategy="on-demand")
    assert "type_text_value__field" not in questions
    result = parse_decision(observation, {
        "operation": choice("TYPE_TEXT"), "type_text_target": choice("field")
    }, text_strategy="on-demand")
    assert "text" not in result
    question = text_question_for_target(observation, result["target"])
    assert question["type"] == "text"
    apply_text_value(result, {"text": "London", "found": 0.99})
    assert result["text"] == "London"


def test_spinbutton_exposes_semantic_step_actions():
    observation = {
        "elements": [
            {"id": "adults", "role": "spinbutton", "name": "Adults", "value": "2",
             "actions": ["click", "type", "increment", "decrement"]}
        ]
    }
    questions = build_questions(observation)
    assert set(questions["increment_target"]["criteria"]) == {"adults"}
    assert set(questions["decrement_target"]["criteria"]) == {"adults"}
    result = parse_decision(observation, {
        "operation": choice("INCREMENT"), "increment_target": choice("adults")
    })
    assert result["operation"] == "INCREMENT"
    assert result["target"] == "adults"


def test_parse_decision_returns_validated_operation_and_target():
    result = parse_decision(state(), {"operation": choice("CLICK"), "click_target": choice("search")})
    assert result["operation"] == "CLICK"
    assert result["target"] == "search"
    assert result["target_confidence"] == 0.8


def test_terminal_decision_needs_no_target():
    result = parse_decision(state(), {"operation": choice("DONE")})
    assert result["target"] is None


def test_type_text_uses_only_the_selected_targets_extracted_value():
    result = parse_decision(state(), {
        "operation": choice("TYPE_TEXT"),
        "type_text_target": choice("field"),
        "type_text_value__field": {"text": "London", "found": 0.99, "span": [5, 11]},
    })
    assert result["target"] == "field"
    assert result["text"] == "London"


def test_paste_text_uses_its_own_target_and_literal_value_heads():
    observation = state()
    observation["elements"][0]["actions"].append("paste")
    questions = build_questions(observation)
    assert set(questions["paste_text_target"]["criteria"]) == {"field"}
    assert "paste_text_value__field" in questions
    result = parse_decision(observation, {
        "operation": choice("PASTE_TEXT"),
        "paste_text_target": choice("field"),
        "paste_text_value__field": {"text": "Document body", "found": 0.99},
    })
    assert result["operation"] == "PASTE_TEXT"
    assert result["target"] == "field"
    assert result["text"] == "Document body"


def test_paste_text_on_demand_uses_the_paste_target_for_text_extraction():
    observation = state()
    observation["elements"][0]["actions"].append("paste")
    result = parse_decision(observation, {
        "operation": choice("PASTE_TEXT"), "paste_text_target": choice("field")
    }, text_strategy="on-demand")
    assert "text" not in result
    assert text_question_for_target(observation, result["target"], "PASTE_TEXT")["type"] == "text"


def test_type_text_rejects_missing_literal_value():
    with pytest.raises(DecisionError, match="No literal input text"):
        parse_decision(state(), {
            "operation": choice("TYPE_TEXT"),
            "type_text_target": choice("field"),
            "type_text_value__field": {"text": None, "found": 0.1},
        })


def test_model_cannot_invent_a_target():
    with pytest.raises(DecisionError, match="not valid"):
        parse_decision(state(), {"operation": choice("CLICK"), "click_target": choice("invented")})


def test_model_cannot_choose_an_unavailable_operation():
    observation = state()
    observation["can_scroll_down"] = False
    with pytest.raises(DecisionError, match="not available"):
        parse_decision(observation, {"operation": choice("SCROLL_DOWN")})


def test_missing_speculative_head_is_rejected():
    with pytest.raises(DecisionError, match="Missing speculative"):
        parse_decision(state(), {"operation": choice("TYPE_TEXT")})
