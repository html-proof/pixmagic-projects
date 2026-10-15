// File writers for staff exports: CSV, Excel (.xlsx) and PDF. No dependencies, no Node APIs, so
// they run on Workers; each builds the whole file in memory (reports are bounded in size).

const enc = new TextEncoder();

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180), with spreadsheet formula injection neutralized
// ---------------------------------------------------------------------------------------------

/** A text cell that a spreadsheet would run as a formula gets a leading apostrophe. */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
}

export function toCsv(header: string[], rows: Array<Array<string | number | null>>): Uint8Array {
  // Text is always quoted: Excel in a locale whose list separator is ";" splits an unquoted cell on
  // it, so `Bob;=HYPERLINK(...)` would become a second, live formula cell despite safeText.
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(v)) return String(v);
    return `"${safeText(v).replace(/"/g, '""')}"`;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(","));
  // BOM so Excel opens UTF-8 names correctly.
  return enc.encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}

// ---------------------------------------------------------------------------------------------
// ZIP (stored, no compression) for .xlsx
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Excel .xlsx (one sheet; numbers as numbers with 2-decimal formats, text as inline strings)
// ---------------------------------------------------------------------------------------------

export type XlsxCell = { t: "text"; v: string } | { t: "number"; v: string } | { t: "empty" };

// eslint-disable-next-line no-control-regex -- removing characters XML can't hold is the point
const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function toXlsx(sheetName: string, title: string[], header: string[], rows: XlsxCell[][]): Uint8Array {
  const out: string[] = [];
  let r = 0;
  const row = (cells: string[]) => out.push(`<row r="${++r}">${cells.join("")}</row>`);
  for (const line of title) row([`<c r="A${r + 1}" t="inlineStr" s="1"><is><t>${xml(line)}</t></is></c>`]);
  if (title.length) row([]);
  row(header.map((h, i) => `<c r="${colName(i)}${r + 1}" t="inlineStr" s="1"><is><t>${xml(h)}</t></is></c>`));
  for (const cells of rows) {
    const n = r + 1;
    row(
      cells.map((c, i) => {
        const ref = `${colName(i)}${n}`;
        if (c.t === "empty") return `<c r="${ref}"/>`;
        if (c.t === "number") return `<c r="${ref}" s="2"><v>${xml(c.v)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
      }),
    );
  }
  const widths = header.map((h, i) => Math.min(48, Math.max(10, h.length + 2, ...rows.slice(0, 200).map((c) => (c[i]?.t === "empty" ? 0 : (c[i] as { v: string })?.v.length ?? 0) + 2))));
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${out.join("")}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const name = xml(sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
    "xl/styles.xml": styles,
  };
  return zipStore(Object.entries(files).map(([n, s]) => ({ name: n, data: enc.encode(s) })));
}

// ---------------------------------------------------------------------------------------------
// PDF (A4, built-in Helvetica; text outside Windows-1252 shows as "?")
// ---------------------------------------------------------------------------------------------

/** Windows-1252 code for a character, or 63 ("?") when the standard fonts can't draw it. */
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
function pdfText(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    let b = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : (CP1252[cp] ?? 63);
    if (cp === 0x202f || cp === 0x00a0) b = 0x20;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

/** Approximate Helvetica advance widths (per 1000 units) for layout. */
function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    if ("il.,:;'|!".includes(ch)) w += 278;
    else if ("ftrjI ()[]-".includes(ch)) w += 333;
    else if ("mwMW".includes(ch)) w += 833;
    else if (/[A-Z]/.test(ch)) w += 667;
    else if (/[0-9$]/.test(ch)) w += 556;
    else w += 520;
  }
  return (w * size * (bold ? 1.05 : 1)) / 1000;
}

export class PdfDoc {
  private pages: string[][] = [];
  private cur: string[] = [];
  readonly width = 595;
  readonly height = 842;
  readonly margin = 48;
  y = 0;

  constructor() {
    this.addPage();
  }

  addPage() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = this.height - this.margin;
  }

  /** Make room for `h` points, starting a new page when the current one is full. */
  ensure(h: number) {
    if (this.y - h < this.margin) this.addPage();
  }

  text(x: number, y: number, s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; align?: "left" | "right" } = {}) {
    const size = opts.size ?? 10;
    const [r, g, b] = opts.color ?? [0.1, 0.1, 0.09];
    const dx = opts.align === "right" ? x - textWidth(s, size, opts.bold) : x;
    this.cur.push(`BT /${opts.bold ? "F2" : "F1"} ${size} Tf ${r} ${g} ${b} rg ${dx.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(s)}) Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.85) {
    this.cur.push(`${gray} G 0.75 w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  rect(x: number, y: number, w: number, h: number, fill: [number, number, number]) {
    this.cur.push(`${fill.join(" ")} rg ${x} ${y} ${w} ${h} re f`);
  }

  /** Wrap `s` to `maxWidth` and write it, moving `y` down. */
  paragraph(s: string, opts: { size?: number; color?: [number, number, number]; maxWidth?: number } = {}) {
    const size = opts.size ?? 9;
    const max = opts.maxWidth ?? this.width - 2 * this.margin;
    const words = s.split(/\s+/);
    let line = "";
    const flush = () => {
      if (!line) return;
      this.ensure(size + 3);
      this.text(this.margin, this.y, line, { size, color: opts.color });
      this.y -= size + 3;
      line = "";
    };
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, size) > max) {
        flush();
        line = w;
      } else line = next;
    }
    flush();
  }

  /** A table: header row, then rows; columns right-aligned when `numeric`. Breaks across pages. */
  table(cols: Array<{ label: string; width: number; numeric?: boolean }>, rows: string[][], opts: { size?: number; boldLast?: boolean } = {}) {
    const size = opts.size ?? 8.5;
    const rowH = size + 6;
    const x0 = this.margin;
    const header = () => {
      this.ensure(rowH * 2);
      this.rect(x0, this.y - 4, cols.reduce((a, c) => a + c.width, 0), rowH, [0.95, 0.95, 0.94]);
      let x = x0;
      for (const c of cols) {
        this.text(c.numeric ? x + c.width - 4 : x + 4, this.y, this.fit(c.label, c.width - 8, size, true), { size, bold: true, align: c.numeric ? "right" : "left" });
        x += c.width;
      }
      this.y -= rowH;
    };
    header();
    rows.forEach((r, ri) => {
      if (this.y - rowH < this.margin) {
        this.addPage();
        header();
      }
      let x = x0;
      const bold = !!opts.boldLast && ri === rows.length - 1;
      cols.forEach((c, i) => {
        const v = this.fit(r[i] ?? "", c.width - 8, size, bold);
        this.text(c.numeric ? x + c.width - 4 : x + 4, this.y, v, { size, bold, align: c.numeric ? "right" : "left" });
        x += c.width;
      });
      this.line(x0, this.y - 4, x0 + cols.reduce((a, c) => a + c.width, 0), this.y - 4, 0.9);
      this.y -= rowH;
    });
  }

  private fit(s: string, width: number, size: number, bold: boolean) {
    if (textWidth(s, size, bold) <= width) return s;
    let t = s;
    while (t.length > 1 && textWidth(`${t}…`, size, bold) > width) t = t.slice(0, -1);
    return `${t}…`;
  }

  toBytes(meta: { title: string }): Uint8Array {
    const objs: string[] = [];
    const add = (s: string) => objs.push(s) - 1 + 1;
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 7.5 Tf 0.45 0.45 0.42 rg ${this.margin} 24 Td (${pdfText(`${meta.title}  ·  Page ${i + 1} of ${total}`)}) Tj ET`;
      const stream = [...ops, footer].join("\n");
      const content = add(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const info = add(`<< /Title (${pdfText(meta.title)}) /Producer (bizinsights) >>`);
    // Byte offsets: every string here is ASCII after pdfText escaping, so length = bytes.
    let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(latin1Length(body));
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xrefAt = latin1Length(body);
    body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    body += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return latin1Bytes(body);
  }
}

const latin1Length = (s: string) => s.length;
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
