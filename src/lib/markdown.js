import { marked } from 'marked';
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
    a: ['href', 'title'],
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
    // Untrusted outbound links must not be able to reach back through
    // window.opener, and should not pass PageRank from a members' blog.
    a: (tagName, attribs) => {
      const href = attribs.href || '';
      const external = /^https?:\/\//i.test(href);
      return {
        tagName: 'a',
        attribs: external
          ? { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }
          : attribs,
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
