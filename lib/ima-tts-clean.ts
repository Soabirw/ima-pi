const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[^>]+>/g;
const FENCED_CODE_BLOCK = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[^\n]*(?:\n|$)/gm;
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()]+/g;
const ABSOLUTE_PATH = /(^|[\s(])\/(?:[^\s/]+\/)*[^\s/)\],;:!?]+/gm;
const HEADING_MARKER = /^[ \t]{0,3}#{1,6}\s+/gm;
const BLOCKQUOTE_MARKER = /^[ \t]*>\s?/gm;
const UNORDERED_LIST_MARKER = /^[ \t]*[-*+]\s+/gm;
const ORDERED_LIST_MARKER = /^[ \t]*\d+[.)]\s+/gm;
const EMPHASIS_PUNCTUATION = /[*_~]/g;

export const cleanForSpeech = (text: string): string => {
  const withoutHtml = text
    .replace(HTML_COMMENT, "")
    .replace(HTML_TAG, "");
  const withoutFencedCode = withoutHtml.replace(FENCED_CODE_BLOCK, "");
  const withoutInlineCodeDelimiters = withoutFencedCode.replaceAll("`", "");
  const withoutLinkDestinations = withoutInlineCodeDelimiters.replace(MARKDOWN_LINK, "$1");
  const withoutUrlsAndPaths = withoutLinkDestinations
    .replace(BARE_URL, "")
    .replace(ABSOLUTE_PATH, "$1");
  const withoutMarkdownMarkers = withoutUrlsAndPaths
    .replace(HEADING_MARKER, "")
    .replace(BLOCKQUOTE_MARKER, "")
    .replace(UNORDERED_LIST_MARKER, "")
    .replace(ORDERED_LIST_MARKER, "")
    .replace(EMPHASIS_PUNCTUATION, "");

  return withoutMarkdownMarkers
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
