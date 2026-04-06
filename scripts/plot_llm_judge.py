#!/usr/bin/env python3
import json
import math
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPORTS_DIR = Path(os.environ.get('REPORTS_DIR', 'tests/llm-judge/reports'))
INPUT = os.environ.get('INPUT', '').strip()
OUTPUT = os.environ.get('OUTPUT', '').strip()
TITLE = os.environ.get('TITLE', 'LLM Judge Accuracy')


def latest_report_path() -> Path:
    files = sorted(REPORTS_DIR.glob('llm-judge-*.json'))
    if not files:
        raise FileNotFoundError(f'No judge report found in {REPORTS_DIR}')
    return files[-1]


def load_report(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return json.load(f)


def pick_font(size=14):
    for p in [
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/SFNS.ttf',
    ]:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def color_for(idx: int):
    palette = [
        (47, 111, 255),
        (38, 166, 154),
        (244, 143, 33),
        (171, 71, 188),
        (121, 85, 72),
        (236, 64, 122),
    ]
    return palette[idx % len(palette)]


def main():
    in_path = Path(INPUT) if INPUT else latest_report_path()
    report = load_report(in_path)

    rows = report.get('results', [])
    if not rows:
        raise ValueError('No results in report.')

    model_keys = []
    model_to_scores = {}

    for case_idx, case in enumerate(rows):
        judged = case.get('judged', [])
        for j in judged:
            model_key = f"{j.get('provider','?')}/{j.get('model','?')}"
            if model_key not in model_to_scores:
                model_to_scores[model_key] = [None] * len(rows)
                model_keys.append(model_key)
            score = j.get('judgment', {}).get('overall_score_100', 0)
            try:
                score = float(score)
            except Exception:
                score = 0.0
            model_to_scores[model_key][case_idx] = score / 100.0

    width, height = 1200, 720
    left, top, right, bottom = 90, 80, 60, 120
    chart_w = width - left - right
    chart_h = height - top - bottom

    bg = Image.new('RGB', (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(bg)

    font_title = pick_font(28)
    font_axis = pick_font(16)
    font_small = pick_font(13)

    draw.text((left, 20), TITLE, fill=(33, 33, 33), font=font_title)

    y_min = 0.0
    y_max = 1.0
    y_ticks = [i / 10 for i in range(0, 11)]

    draw.rectangle([left, top, left + chart_w, top + chart_h], outline=(170, 170, 170), width=1)

    for t in y_ticks:
        y = top + int((y_max - t) / (y_max - y_min) * chart_h)
        line_color = (230, 230, 230)
        draw.line([(left, y), (left + chart_w, y)], fill=line_color, width=1)
        draw.text((left - 48, y - 8), f"{t:.1f}", fill=(90, 90, 90), font=font_small)

    n = len(rows)
    x_step = chart_w / max(n - 1, 1)

    for i in range(n):
        x = left + int(i * x_step)
        draw.line([(x, top), (x, top + chart_h)], fill=(240, 240, 240), width=1)
        draw.text((x - 6, top + chart_h + 8), str(i), fill=(90, 90, 90), font=font_small)

    for idx, model_key in enumerate(model_keys):
        pts = []
        color = color_for(idx)
        scores = model_to_scores[model_key]
        for i, s in enumerate(scores):
            if s is None:
                continue
            x = left + int(i * x_step)
            y = top + int((y_max - s) / (y_max - y_min) * chart_h)
            pts.append((x, y))

        if len(pts) >= 2:
            draw.line(pts, fill=color, width=3)
        for p in pts:
            r = 4
            draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill=color, outline=(255,255,255), width=1)

    draw.text((left + chart_w // 2 - 30, top + chart_h + 42), 'Query Index', fill=(70,70,70), font=font_axis)
    draw.text((20, top + chart_h // 2 - 10), 'Score', fill=(70,70,70), font=font_axis)

    legend_x = left + chart_w - 320
    legend_y = top + 12
    legend_h = 22 * max(len(model_keys), 1) + 16
    draw.rectangle([legend_x, legend_y, left + chart_w - 10, legend_y + legend_h], outline=(200,200,200), fill=(250,250,250), width=1)
    ly = legend_y + 8
    for idx, model_key in enumerate(model_keys):
        color = color_for(idx)
        draw.line([(legend_x + 10, ly + 8), (legend_x + 36, ly + 8)], fill=color, width=3)
        draw.ellipse([legend_x + 20 - 3, ly + 8 - 3, legend_x + 20 + 3, ly + 8 + 3], fill=color)
        draw.text((legend_x + 44, ly), model_key, fill=(50,50,50), font=font_small)
        ly += 22

    out_path = Path(OUTPUT) if OUTPUT else in_path.with_suffix('.png')
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bg.save(out_path, format='PNG')
    print(str(out_path))


if __name__ == '__main__':
    main()
