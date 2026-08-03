#!/usr/bin/env python3
"""
Extract body content from any HTML email and wrap it in a styled div.

Strips document-level tags (<html>, <head>, <body>) and migrates body styles
to a wrapping div. Works on BeeFree exports, IMA emails, or any HTML.

Usage:
    python3 espocrm-prep.py input.html
    python3 espocrm-prep.py input.html --out output.html
"""

import argparse
import sys
from bs4 import BeautifulSoup


def extract_body_content(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    body = soup.find("body")

    if body is None:
        return html

    style = body.get("style", "")
    if not style:
        return body.decode_contents()

    wrapper = soup.new_tag("div")
    wrapper["style"] = style
    for child in list(body.contents):
        wrapper.append(child.extract())
    return str(wrapper)


def main():
    parser = argparse.ArgumentParser(description="Prepare HTML email for EspoCRM")
    parser.add_argument("input", help="Input HTML file")
    parser.add_argument("--out", help="Output file (default: stdout)")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        html = f.read()

    result = extract_body_content(html)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(result)
    else:
        sys.stdout.write(result)


if __name__ == "__main__":
    main()
