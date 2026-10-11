/**
 * Hand-built PDFs for the tests. There is no real PDF in the repository, so
 * these are the smallest valid documents that pdf.js reads: one page per entry,
 * with an xref table whose offsets are computed rather than typed.
 *
 * An entry is the text that page draws in Helvetica, one line per "\n", or
 * `null` for a page that draws only a filled rectangle -- what a scanned page
 * looks like to a text extractor: something is on it, and none of it is text.
 */
export function makePdf(pageTexts) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };

  const catalog = add(null);
  const pages = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const text of pageTexts) {
    // Text is drawn a line at a time (split on "\n"): pdf.js drops what runs
    // off the edge of the page, so a long single line would be cut short.
    const stream = text === null
      ? '0.5 g 72 72 468 648 re f'
      : `BT /F1 10 Tf 14 TL 72 720 Td ${text.split('\n')
        .map(line => `(${line.replace(/[\\()]/g, ch => `\\${ch}`)}) Tj T*`).join(' ')} ET`;
    const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> >>`
    ));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) { out += `${String(offset).padStart(10, '0')} 00000 n \n`; }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
