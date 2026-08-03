#!/usr/bin/env python3
"""Inline self-contained CSS into email markup without external retrieval."""

import argparse
import re
import sys
from html.parser import HTMLParser

import premailer


EXTERNAL_CSS_SOURCE = re.compile(
    r"(?:@import\s+(?:url\(\s*)?|url\(\s*)[\"']?\s*(?:https?:|file:|ftp:|data:|//|/)",
    re.IGNORECASE,
)


class CssSourceParser(HTMLParser):
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag.lower() == "link" and "href" in attributes:
            raise ValueError("external stylesheet links are not allowed")
        style = attributes.get("style")
        if style and EXTERNAL_CSS_SOURCE.search(style):
            raise ValueError("external CSS sources are not allowed")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        if self.lasttag == "style" and EXTERNAL_CSS_SOURCE.search(data):
            raise ValueError("external CSS sources are not allowed")


def reject_external_css_sources(html: str) -> None:
    """Reject external CSS references before Premailer can retrieve them."""
    parser = CssSourceParser()
    parser.feed(html)
    parser.close()


def inline_css(html: str) -> str:
    reject_external_css_sources(html)
    return premailer.transform(
        html,
        remove_classes=False,
        strip_important=True,
        keep_style_tags=False,
        allow_network=False,
        allow_loading_external_files=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Inline CSS for email compatibility")
    parser.add_argument("input", help="Input HTML file")
    parser.add_argument("--out", help="Output file (default: stdout)")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as file:
        html = file.read()

    try:
        result = inline_css(html)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as file:
            file.write(result)
    else:
        sys.stdout.write(result)


if __name__ == "__main__":
    main()
