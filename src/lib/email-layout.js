/**
 * The look of the chapter's HTML email.
 *
 * Email clients are not browsers: no external CSS, patchy support for modern
 * layout, and Outlook renders with Word's engine. So this is the old reliable
 * recipe -- nested tables, inline styles, a background colour on every cell
 * that matters -- with the site's own palette (EAA blue band, EAA yellow
 * button, warm cream page) so it reads as the same place as the website.
 *
 * Every message also ships a plain-text body; the HTML is the nicer copy, not
 * the only one. Anything that came from a person or the database goes through
 * `esc`, so an event title cannot inject markup into a member's inbox.
 */

const C = {
  navy900: '#021f33',
  navy700: '#064670',
  blue: '#005b94',
  blue100: '#dceefa',
  amber: '#fcb040',
  amber100: '#fdeed6',
  amberInk: '#7c4a08',
  cream: '#fdf9f2',
  ink: '#17252f',
  inkSoft: '#4a5b6b',
  inkFaint: '#7d8b98',
  line: '#e3e8ee',
};

const FONT = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A paragraph of body copy. `html` must already be safe. */
export const para = (html, style = '') =>
  `<p style="margin:0 0 16px; font-size:16px; line-height:1.6; color:${C.ink}; ${style}">${html}</p>`;

/** A labelled detail ("WHEN  Monday, October 26 at 7:00 PM"). `valueHtml` must already be safe. */
export function detailRow(label, valueHtml) {
  return `<tr>
    <td valign="top" style="padding:10px 16px 10px 0; width:72px; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:${C.inkFaint}; border-top:1px solid ${C.line};">${esc(label)}</td>
    <td valign="top" style="padding:10px 0; font-size:16px; line-height:1.5; color:${C.ink}; border-top:1px solid ${C.line};">${valueHtml}</td>
  </tr>`;
}

/** The yellow call-to-action button, built as a table so it holds up in Outlook. */
export function button(label, url) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
    <tr>
      <td align="center" bgcolor="${C.amber}" style="border-radius:999px; background:${C.amber};">
        <a href="${esc(url)}" target="_blank" style="display:inline-block; padding:14px 28px; font-family:${FONT}; font-size:16px; font-weight:700; color:${C.navy900}; text-decoration:none; border-radius:999px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * @param {object} o
 * @param {string} o.preheader   The grey preview line some inboxes show beside the subject.
 * @param {string} o.eyebrow     Small caps label above the title ("Meeting reminder").
 * @param {string} o.title       The headline, in the blue band.
 * @param {string} [o.subtitle]  A line under it.
 * @param {string} o.bodyHtml    Already-safe HTML for the white card.
 * @param {string} [o.logoSrc]  Where the badge image comes from. Defaults to the copy attached to the
 *                              message itself (see mailer.inlineAttachments), so it shows without
 *                              the reader having to "load remote images" and without another site.
 * @param {string} o.footerHtml  Already-safe HTML for the small print.
 */
export const LOGO_CID = 'eaa-logo';

export function renderEmail({ preheader, eyebrow, title, subtitle = '', bodyHtml, logoSrc = `cid:${LOGO_CID}`, footerHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background:${C.cream}; font-family:${FONT};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:${C.cream};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.cream}" style="background:${C.cream};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;">

        <tr>
          <td bgcolor="${C.blue}" style="background:${C.blue}; background-image:linear-gradient(160deg, ${C.blue} 0%, ${C.navy700} 100%); border-radius:18px 18px 0 0; padding:28px 32px 30px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:12px;"><img src="${esc(logoSrc)}" width="48" height="48" alt="EAA Chapter 1699" style="display:block; border:0; border-radius:24px;"></td>
                <td valign="middle" style="font-family:${FONT}; color:#ffffff;">
                  <div style="font-size:16px; font-weight:700; line-height:1.2;">EAA Chapter 1699</div>
                  <div style="font-size:13px; line-height:1.3; color:${C.blue100};">South Albany Airport &middot; 4B0</div>
                </td>
              </tr>
            </table>
            <div style="margin:26px 0 6px; font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:${C.amber};">${esc(eyebrow)}</div>
            <div style="font-size:28px; font-weight:800; line-height:1.15; color:#ffffff;">${esc(title)}</div>
            ${subtitle ? `<div style="margin-top:8px; font-size:16px; line-height:1.4; color:${C.blue100};">${esc(subtitle)}</div>` : ''}
          </td>
        </tr>
        <tr><td height="4" bgcolor="${C.amber}" style="background:${C.amber}; font-size:0; line-height:0;">&nbsp;</td></tr>

        <tr>
          <td bgcolor="#ffffff" style="background:#ffffff; padding:28px 32px 8px; border-left:1px solid ${C.line}; border-right:1px solid ${C.line};">
            ${bodyHtml}
          </td>
        </tr>
        <tr><td height="1" bgcolor="${C.line}" style="background:${C.line}; font-size:0; line-height:0;">&nbsp;</td></tr>

        <tr>
          <td style="padding:20px 8px 0; font-size:12px; line-height:1.6; color:${C.inkFaint}; text-align:center;">
            ${footerHtml}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Link styled for the footer and for inline use. */
export const link = (url, label, color = '#0077c0') =>
  `<a href="${esc(url)}" target="_blank" style="color:${color}; text-decoration:underline;">${esc(label)}</a>`;
