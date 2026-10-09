import TurndownService from 'turndown';
import sanitizeHtml from 'sanitize-html';

/**
 * The rich-text editor's other half.
 *
 * Members write in a WYSIWYG editor (Trix) rather than typing markdown, but
 * markdown is still what gets stored: it is readable without this application,
 * survives a change of editor, and diffs sensibly in the post revision
 * history. So the editor's HTML is converted back to markdown on the way in.
 *
 * The order matters. The HTML arriving here came from a browser and is
 * therefore untrusted -- somebody can put anything in that field with a
 * scripted POST. It is sanitised against an allow-list *first*, then
 * converted. Anything that is not on the list never reaches the converter, and
 * so cannot end up in the stored markdown.
 */
const INPUT_SANITIZE = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'div', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike',
    'ul', 'ol', 'li', 'a',
  ],
  allowedAttributes: { a: ['href', 'title'] },
  // No 'data:' and no 'javascript:'.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

const turndown = new TurndownService({
  headingStyle: 'atx', // "## Heading", not underlines
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

// Trix marks strikethrough with <del> and <strike>; Turndown ignores both by
// default and would silently drop the text's formatting.
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content) => `~~${content}~~`,
});

// Underline has no markdown equivalent. Keeping the text and losing the
// underline beats emitting a raw <u> that the output sanitiser then strips.
turndown.addRule('underline', {
  filter: ['u'],
  replacement: (content) => content,
});

/** Editor HTML -> markdown, for storage. */
export function htmlToMarkdown(html) {
  const raw = String(html ?? '').trim();
  if (!raw) return '';
  const clean = sanitizeHtml(raw, INPUT_SANITIZE);
  return turndown
    .turndown(clean)
    .replace(/\n{3,}/g, '\n\n') // Trix is fond of empty paragraphs
    .trim();
}

/**
 * True when a submitted field came from the rich editor rather than the
 * plain textarea fallback. The form declares this explicitly rather than
 * guessing from the content, because markdown and HTML are easy to confuse
 * and a wrong guess mangles somebody's writing.
 */
export function isHtmlPayload(body, field) {
  return String(body?.[`${field}_format`] ?? '') === 'html';
}

/**
 * Normalises one long-form field to markdown, whichever editor produced it.
 * Returns a body-like object so it can be fed straight to `validate()`.
 */
export function normaliseRichField(body, field) {
  if (!isHtmlPayload(body, field)) return body;
  return { ...body, [field]: htmlToMarkdown(body[field]) };
}
