from dsh_cu_decision.visual_metrics import center, center_inside, evaluate_box, iou
from dsh_cu_decision.visual_browser_benchmark import expected_box_from_css
from dsh_cu_decision.official_cua_visual import prediction_center_in_window_points, expected_box_from_ax
from dsh_cu_decision.official_cua_axless_visual import point_in_box
import pytest


EXPECTED = {"left": 0.1, "top": 0.2, "right": 0.3, "bottom": 0.4}


def test_iou_and_pixel_center():
    assert iou(EXPECTED, EXPECTED) == 1.0
    assert center(EXPECTED, (1000, 500)) == pytest.approx((200, 150))


def test_center_inside_is_checked_in_normalized_space():
    assert center_inside(EXPECTED, EXPECTED)
    outside = {"left": 0.7, "top": 0.7, "right": 0.8, "bottom": 0.8}
    assert not center_inside(outside, EXPECTED)


def test_present_box_is_scored_with_click_center():
    answer = {"box": EXPECTED, "found": 1.0, "confidence": 0.9}
    result = evaluate_box(answer, EXPECTED, (1000, 500))
    assert result["correct"]
    assert result["iou"] == 1.0
    assert result["center_error_px"] == 0


def test_absent_target_requires_model_to_abstain():
    assert evaluate_box({"box": None, "found": 0.1}, None, (800, 600))["correct"]
    assert not evaluate_box({"box": EXPECTED, "found": 0.9}, None, (800, 600))["correct"]


def test_retina_css_box_is_normalized_against_actual_screenshot_pixels():
    css_box = {"x": 100, "y": 50, "width": 200, "height": 80}
    result = expected_box_from_css(css_box, (800, 600), (1600, 1200))
    assert result == {"left": 0.125, "top": 50 / 600, "right": 0.375, "bottom": 130 / 600}


def test_official_cua_ax_bounds_and_window_point_mapping():
    screenshot = {"bounds": {"x": 221, "y": 350, "width": 420, "height": 532}}
    target = {"bounds": [250, 484, 202, 34]}
    expected = expected_box_from_ax(target, screenshot)
    assert expected == {
        "left": 29 / 420, "top": 134 / 532,
        "right": 231 / 420, "bottom": 168 / 532,
    }
    x, y = prediction_center_in_window_points(expected, screenshot)
    assert x == 130
    assert y == 151


def test_axless_guard_requires_box_to_contain_fixture_point():
    box = {"left": 0.1, "top": 0.2, "right": 0.5, "bottom": 0.6}
    assert point_in_box((50, 80), box, (100, 200))
    assert not point_in_box((80, 80), box, (100, 200))
