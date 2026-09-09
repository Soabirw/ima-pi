import { Buffer } from "node:buffer";
import { compile } from "html-to-text";
import { parseDocument } from "htmlparser2";

export const DESCRIPTION_INPUT_MAXIMUM_BYTES = 128 * 1024;
export const DESCRIPTION_OUTPUT_MAXIMUM_BYTES = 48 * 1024;
export const DESCRIPTION_SERIALIZED_MAXIMUM_BYTES = 60_000;
export const DESCRIPTION_MAXIMUM_NODES = 4_096;
export const DESCRIPTION_MAXIMUM_DEPTH = 64;

const DESCRIPTION_FIELDS = [
  "description_stripped",
  "description",
  "description_html",
];
const IGNORED_NODE_TYPES = new Set(["comment", "directive"]);
const IGNORED_ELEMENT_NAMES = new Set(["base", "link", "meta"]);
const ALLOWED_ELEMENT_NAMES = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "i",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);
const htmlToText = compile({
  baseElements: { selectors: [], returnDomByDefault: true },
  decodeEntities: true,
  wordwrap: false,
  limits: {
    ellipsis: "",
    maxBaseElements: undefined,
    maxChildNodes: undefined,
    maxDepth: undefined,
    maxInputLength: DESCRIPTION_INPUT_MAXIMUM_BYTES,
  },
  selectors: [
    { selector: "a", format: "anchor", options: { ignoreHref: true } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      format: "heading",
      options: { uppercase: false },
    })),
  ],
});

const success = (data) => ({ success: true, data });
const failure = (error) => ({ success: false, error });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const utf8ByteLength = (value) => Buffer.byteLength(value, "utf8");
const isBlank = (value) => value.trim() === "";

const descriptionValuesFrom = (workItem) => {
  if (!isRecord(workItem)) return failure("description_record_invalid");

  const values = {};
  for (const field of DESCRIPTION_FIELDS) {
    const value = Object.hasOwn(workItem, field) ? workItem[field] : null;
    if (value !== null && value !== undefined && typeof value !== "string") {
      return failure("description_field_invalid");
    }
    if (typeof value === "string" && utf8ByteLength(value) > DESCRIPTION_INPUT_MAXIMUM_BYTES) {
      return failure("description_input_too_large");
    }
    values[field] = typeof value === "string" ? value : null;
  }
  return success(values);
};

const isBoundedDescription = (description) =>
  utf8ByteLength(description) <= DESCRIPTION_OUTPUT_MAXIMUM_BYTES
  && utf8ByteLength(JSON.stringify(description)) <= DESCRIPTION_SERIALIZED_MAXIMUM_BYTES;

const boundedDescription = (description) =>
  isBoundedDescription(description)
    ? success(description)
    : failure("description_output_too_large");

const inspectHtmlDocument = (html) => {
  let document;
  try {
    document = parseDocument(html, { decodeEntities: true });
  } catch {
    return failure("description_html_invalid");
  }

  const stack = [...document.children]
    .reverse()
    .map((node) => ({ node, elementDepth: 0 }));
  let nodeCount = 0;
  let hasMeaningfulText = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isRecord(current.node)) return failure("description_html_invalid");

    nodeCount += 1;
    if (nodeCount > DESCRIPTION_MAXIMUM_NODES) return failure("description_html_too_complex");

    const { node, elementDepth } = current;
    if (node.type === "text") {
      if (typeof node.data !== "string") return failure("description_html_invalid");
      hasMeaningfulText ||= !isBlank(node.data);
      continue;
    }
    if (IGNORED_NODE_TYPES.has(node.type)) continue;
    if (node.type !== "tag" || typeof node.name !== "string") {
      return failure("description_html_unsupported");
    }
    if (IGNORED_ELEMENT_NAMES.has(node.name)) continue;
    if (!ALLOWED_ELEMENT_NAMES.has(node.name)) return failure("description_html_unsupported");

    const childDepth = elementDepth + 1;
    if (childDepth > DESCRIPTION_MAXIMUM_DEPTH) return failure("description_html_too_deep");
    if (!Array.isArray(node.children)) return failure("description_html_invalid");

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index], elementDepth: childDepth });
    }
  }

  return success({ hasMeaningfulText });
};

const descriptionFromHtml = (html) => {
  const inspection = inspectHtmlDocument(html);
  if (!inspection.success) return inspection;

  let converted;
  try {
    converted = htmlToText(html);
  } catch {
    return failure("description_html_conversion_failed");
  }
  if (typeof converted !== "string") return failure("description_html_conversion_failed");

  const description = converted.trim();
  if (inspection.data.hasMeaningfulText && description === "") {
    return failure("description_html_conversion_failed");
  }
  return boundedDescription(description);
};

export const normalizeWorkItemDescription = (rawWorkItem) => {
  const values = descriptionValuesFrom(rawWorkItem);
  if (!values.success) return values;

  const hasUnsupportedBinaryContent = Object.hasOwn(rawWorkItem, "description_binary")
    && rawWorkItem.description_binary !== null
    && rawWorkItem.description_binary !== undefined;
  const strippedDescription = values.data.description_stripped;
  if (strippedDescription !== null && !isBlank(strippedDescription)) {
    return boundedDescription(strippedDescription);
  }

  const legacyDescription = values.data.description;
  if (legacyDescription !== null && !isBlank(legacyDescription)) {
    return boundedDescription(legacyDescription);
  }

  const htmlDescription = values.data.description_html;
  if (htmlDescription !== null && !isBlank(htmlDescription)) {
    const description = descriptionFromHtml(htmlDescription);
    if (description.success && description.data === "" && hasUnsupportedBinaryContent) {
      return failure("description_unsupported");
    }
    return description;
  }

  if (hasUnsupportedBinaryContent) return failure("description_unsupported");

  const hasExplicitSupportedDescription = DESCRIPTION_FIELDS.some((field) => values.data[field] !== null);
  return hasExplicitSupportedDescription
    ? success("")
    : failure("description_unavailable");
};
