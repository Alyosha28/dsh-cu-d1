from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
VISUAL_ROOT = ROOT / "fixtures" / "visual"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def normalized(box: tuple[int, int, int, int], size: tuple[int, int]) -> dict[str, float]:
    left, top, right, bottom = box
    width, height = size
    return {
        "left": left / width,
        "top": top / height,
        "right": right / width,
        "bottom": bottom / height,
    }


def button(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    fill: str = "#246bfe",
    text_color: str = "white",
    font_size: int = 26,
) -> None:
    draw.rectangle(box, fill=fill, outline="#202020", width=2)
    f = font(font_size)
    left, top, right, bottom = box
    bounds = draw.textbbox((0, 0), text, font=f)
    x = left + (right - left - (bounds[2] - bounds[0])) / 2
    y = top + (bottom - top - (bounds[3] - bounds[1])) / 2 - bounds[1]
    draw.text((x, y), text, font=f, fill=text_color)


def base(size: tuple[int, int], title: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", size, "#f4f6f8")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, size[0], 64), fill="white")
    draw.text((28, 18), title, font=font(28), fill="#202020")
    return image, draw


def save_case(
    cases: list[dict[str, Any]],
    id: str,
    image: Image.Image,
    instruction: str,
    expected: tuple[int, int, int, int] | None,
) -> None:
    VISUAL_ROOT.mkdir(parents=True, exist_ok=True)
    filename = f"{id}.png"
    image.save(VISUAL_ROOT / filename)
    cases.append({
        "id": id,
        "image": filename,
        "instruction": instruction,
        "expected_box": normalized(expected, image.size) if expected else None,
        "expect_present": expected is not None,
    })


def build_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    image, draw = base((800, 600), "Flight search")
    button(draw, (100, 100, 300, 180), "Search")
    button(draw, (100, 220, 300, 300), "Cancel", fill="#777777")
    save_case(cases, "simple-search", image, "Where is the blue Search button?", (100, 100, 300, 180))

    image, draw = base((1600, 1200), "Flight search")
    button(draw, (200, 200, 600, 360), "Search", font_size=52)
    button(draw, (200, 440, 600, 600), "Cancel", fill="#777777", font_size=52)
    save_case(cases, "retina-search", image, "Where is the blue Search button?", (200, 200, 600, 360))

    image, draw = base((1280, 800), "Save document")
    draw.rectangle((240, 100, 1040, 700), fill="white", outline="#333333", width=2)
    draw.text((300, 160), "Report.txt", font=font(30), fill="#202020")
    draw.rectangle((300, 230, 920, 300), fill="#f8f8f8", outline="#777777", width=2)
    button(draw, (800, 580, 980, 660), "Save")
    button(draw, (560, 580, 740, 660), "Cancel", fill="#777777")
    save_case(cases, "dialog-save", image, "Where is the Save button in the save dialog?", (800, 580, 980, 660))

    image, draw = base((1280, 800), "Flight filters")
    draw.text((100, 160), "Adults", font=font(28), fill="#202020")
    draw.rectangle((100, 210, 280, 270), fill="white", outline="#555555", width=2)
    draw.text((125, 222), "2", font=font(28), fill="#202020")
    draw.rectangle((100, 300, 124, 324), fill="white", outline="#333333", width=2)
    draw.text((145, 294), "Nonstop only", font=font(28), fill="#202020")
    save_case(
        cases, "small-checkbox", image,
        "Where is the Nonstop only checkbox itself, not its text label?", (100, 300, 124, 324),
    )

    image, draw = base((1000, 700), "Destination suggestions")
    button(draw, (150, 250, 850, 330), "London, United Kingdom", fill="white", text_color="#202020")
    button(draw, (150, 340, 850, 420), "London, Ontario, Canada", fill="white", text_color="#202020")
    save_case(
        cases, "london-uk-option", image,
        "Where is the London, United Kingdom option?", (150, 250, 850, 330),
    )

    image, draw = base((1000, 700), "文档编辑")
    button(draw, (100, 120, 320, 220), "保存", font_size=36)
    button(draw, (100, 280, 320, 380), "取消", fill="#777777", font_size=36)
    save_case(cases, "chinese-save", image, "蓝色“保存”按钮在哪里？", (100, 120, 320, 220))

    image, draw = base((1440, 900), "Project dashboard")
    labels = ["New", "Open", "Share", "Rename", "Move", "Copy"]
    for index, label in enumerate(labels):
        button(draw, (60 + index * 180, 100, 210 + index * 180, 155), label, fill="#555555", font_size=22)
    for index in range(6):
        draw.rectangle((70, 240 + index * 80, 1360, 300 + index * 80), fill="white", outline="#cccccc")
        draw.text((95, 252 + index * 80), f"Project item {index + 1}", font=font(24), fill="#333333")
    button(draw, (1180, 100, 1340, 155), "Export", font_size=22)
    save_case(cases, "dense-export", image, "Where is the Export button?", (1180, 100, 1340, 155))

    image, draw = base((1200, 800), "Sales chart")
    draw.rectangle((100, 120, 1100, 600), fill="white", outline="#bbbbbb")
    for index, height in enumerate([120, 240, 180, 330, 280]):
        draw.rectangle((180 + index * 160, 560 - height, 270 + index * 160, 560), fill="#69a7ff")
    button(draw, (950, 650, 1120, 720), "Download", font_size=24)
    save_case(cases, "canvas-download", image, "Where is the Download button for this chart?", (950, 650, 1120, 720))

    image, draw = base((1000, 700), "Document and workspace")
    draw.text((80, 90), "Document", font=font(28), fill="#202020")
    button(draw, (100, 140, 300, 220), "Save")
    draw.text((80, 300), "Workspace", font=font(28), fill="#202020")
    button(draw, (100, 350, 300, 430), "Save")
    save_case(
        cases, "workspace-save", image,
        "Where is the Save button in the Workspace section, not the Document section?", (100, 350, 300, 430),
    )

    image, draw = base((800, 600), "Flight search")
    button(draw, (100, 100, 300, 180), "Search")
    button(draw, (100, 220, 300, 300), "Cancel", fill="#777777")
    save_case(cases, "absent-delete", image, "Where is the Delete account button?", None)

    image, draw = base((800, 600), "Settings")
    draw.text((100, 120), "Current user: Test User", font=font(28), fill="#202020")
    save_case(cases, "absent-submit", image, "Where is the Submit payment button?", None)
    return cases
