"""Turn a verified UTF-8 TSV into one literal, TeX-renderable table."""
import argparse
import csv
from pathlib import Path


ESCAPES = {
    "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def tex_cell(value):
    return "".join(ESCAPES.get(char, " " if char in "\r\n" else char) for char in value)


def write_table(source, destination):
    with source.open(encoding="utf-8-sig", newline="") as stream:
        rows = [row for row in csv.reader(stream, delimiter="\t", strict=True) if row]
    if len(rows) < 2 or not all(rows[0]):
        raise ValueError("Provide a header followed by one or more data rows.")
    width = len(rows[0])
    lines = [r"\begin{tabular}{" + "l" + "r" * (width - 1) + "}", r"\toprule"]
    for index, row in enumerate(rows):
        if len(row) != width:
            raise ValueError(f"Row {index + 1} has {len(row)} cells; expected {width}.")
        lines.append(" & ".join(tex_cell(value) for value in row) + r" \\")
        if index == 0:
            lines.append(r"\midrule")
    lines.extend([r"\bottomrule", r"\end{tabular}"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tsv", type=Path)
    parser.add_argument("tex", type=Path)
    args = parser.parse_args()
    try:
        write_table(args.tsv, args.tex)
    except (OSError, ValueError, csv.Error) as exc:
        parser.exit(1, f"{exc}\n")
