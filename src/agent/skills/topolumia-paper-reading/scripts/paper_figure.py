"""Locate and crop figures or tables on a rendered PDF page.

Coordinates are measured from the top left of the visible page on a 0..1000 scale.
"""
import argparse
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from xml.etree import ElementTree

from PIL import Image


def poppler(name):
    # Prefer tools from one Poppler installation if another pdftotext is on PATH.
    renderer = shutil.which("pdftoppm")
    if renderer:
        candidate = Path(renderer).with_name(name + Path(renderer).suffix)
        if candidate.is_file():
            return str(candidate)
    executable = shutil.which(name)
    if executable:
        return executable
    raise ValueError(f"Poppler executable missing: {name}")


def raster(pdf, page, size, directory):
    prefix = Path(directory) / "page"
    subprocess.run([poppler("pdftoppm"), "-f", str(page), "-l", str(page), "-cropbox",
                    "-singlefile", "-scale-to", str(size), "-png", str(pdf), str(prefix)], check=True)
    return prefix.with_suffix(".png")


def text_pages(pdf, page=None):
    command = [poppler("pdftotext"), "-cropbox", "-bbox-layout", "-enc", "UTF-8"]
    if page is not None:
        command.extend(["-f", str(page), "-l", str(page)])
    out = subprocess.check_output([*command, str(pdf), "-"])
    return ElementTree.fromstring(out).findall(".//{*}page")


def lines_on(page):
    width, height = float(page.attrib["width"]), float(page.attrib["height"])
    for line in page.findall(".//{*}line"):
        box = [round(1000 * float(line.attrib[key]) / span) for key, span in
               (("xMin", width), ("yMin", height), ("xMax", width), ("yMax", height))]
        words = " ".join(w.text or "" for w in line.findall("{*}word"))
        yield box, words


def labels(args):
    pages = text_pages(args.pdf)
    if not pages:
        raise ValueError("No pages returned.")
    print(f"PDF pages: {len(pages)}")
    caption = re.compile(r"^(?:Figure|Fig\.?|Table)\s+\d+[\w.-]*\s*[:.：]|^[图圖表]\s*\d+\b", re.I)
    for number, page in enumerate(pages, 1):
        for box, words in lines_on(page):
            if caption.match(words):
                print(number, *box, words[:110], sep="\t")


def layout(args):
    pages = text_pages(args.pdf, args.page)
    if not pages:
        raise ValueError("No page returned. Check the one-based page number.")
    for box, words in lines_on(pages[0]):
        print(*box, words[:110], sep="\t")
    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as temp:
            shutil.copyfile(raster(args.pdf, args.page, 1300, temp), args.preview)


def crop(args):
    left, top, right, bottom = args.box
    if not (0 <= left < right <= 1000 and 0 <= top < bottom <= 1000):
        raise ValueError("Use a nonempty box in the 0..1000 page coordinates.")
    if args.box == [0, 0, 1000, 1000]:
        raise ValueError("Select the figure or table bounds. For a full page use layout --preview locally.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        with Image.open(raster(args.pdf, args.page, 3200, temp)) as source:
            w, h = source.size
            box = (math.floor(w * left / 1000), math.floor(h * top / 1000),
                   math.ceil(w * right / 1000), math.ceil(h * bottom / 1000))
            with source.crop(box) as excerpt:
                excerpt.save(args.output, format="PNG")
                print(f"{args.output}: {excerpt.width} x {excerpt.height}, page {args.page}, box {args.box}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    find = commands.add_parser("labels", help="Count pages and list likely figure and table captions.")
    find.add_argument("pdf", type=Path)
    locate = commands.add_parser("layout", help="Show text-line coordinates and an optional local page preview.")
    extract = commands.add_parser("crop", help="Save the selected rectangle as a PNG.")
    for command in (locate, extract):
        command.add_argument("pdf", type=Path)
        command.add_argument("page", type=int)
    locate.add_argument("--preview", type=Path, help="Private full-page working image, never the uploaded crop.")
    extract.add_argument("output", type=Path)
    extract.add_argument("--box", type=int, nargs=4, required=True, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    args = parser.parse_args()
    if getattr(args, "page", 1) < 1:
        parser.error("Page numbers start at 1.")
    try:
        {"labels": labels, "layout": layout, "crop": crop}[args.action](args)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
