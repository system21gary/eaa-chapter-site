import { marked, Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });

/**
 * Markdown -> HTML for member-authored content (blog posts, event write-ups).
 *
 * The critical rule: sanitising happens *after* rendering, on an allow-list.
 * Anything not explicitly permitted -- <script>, <style>, <iframe>, event
 * handler attributes, javascript:/data: URLs, <form>, <object> -- is stripped,
 * so a member with posting rights still cannot land stored XSS on the site.
 */
const SANITIZE_OPTIONS = {
  allowedTags: [
    'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'sup', 'sub',
    'ul', 'ol', 'li', 'hr', 'br',
    'a', 'img', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    // target and rel are set by the transform below, never taken from the
    // author: sanitize-html filters attributes *after* transformTags, so they
    // have to be on this list or the transform's work is thrown away.
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'loading', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    code: ['class'],
  },
  // No 'data:' and no 'javascript:'. Relative links are handled separately.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // Links to other sites open in a new tab, so the reader keeps their place
    // here. Untrusted outbound links must not be able to reach back through
    // window.opener, and should not pass PageRank from a members' blog. Links
    // within the site open in place; any target or rel an author typed is
    // dropped either way.
    a: (tagName, attribs) => {
      const { target, rel, ...rest } = attribs;
      const href = rest.href || '';
      const external = /^https?:\/\//i.test(href);
      return {
        tagName: 'a',
        attribs: external
          ? { ...rest, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }
          : rest,
      };
    },
    img: (tagName, attribs) => ({
      tagName: 'img',
      attribs: { ...attribs, loading: 'lazy', decoding: 'async' },
    }),
  },
};

export function renderMarkdown(md) {
  if (!md) return '';
  const raw = marked.parse(String(md), { async: false });
  return sanitizeHtml(raw, SANITIZE_OPTIONS);
}

/**
 * Markdown -> HTML for loading into the rich-text editor.
 *
 * The editor (Trix) has no tables: given a <table> it flattens the cells into
 * one line of text, and saving would then lose the table for good. So here a
 * table is shown as its markdown source, one row per line, which the member
 * can edit as text and which converts straight back to the same table on save
 * (see richtext.js). Everything else renders exactly as on the page.
 */
const editorMarked = new Marked({ gfm: true, breaks: true });
editorMarked.use({
  renderer: {
    table(token) {
      const lines = token.raw.trim().split('\n').map((l) => escapeText(l.trim()));
      return `<p>${lines.join('<br>')}</p>\n`;
    },
  },
});

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdownForEditor(md) {
  if (!md) return '';
  const raw = editorMarked.parse(String(md), { async: false });
  return sanitizeHtml(raw, SANITIZE_OPTIONS);
}

/** Plain-text excerpt for meta descriptions and list pages. */
export function excerpt(md, length = 200) {
  const text = sanitizeHtml(marked.parse(String(md ?? ''), { async: false }), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= length) return text;
  return `${text.slice(0, text.lastIndexOf(' ', length) || length)}…`;
}

/** Strips all markup -- used for comment bodies, which never render HTML. */
export function stripHtml(input) {
  return sanitizeHtml(String(input ?? ''), { allowedTags: [], allowedAttributes: {} });
}
