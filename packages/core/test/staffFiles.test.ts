import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { PdfDoc, toCsv, toXlsx, zipStore } from "../src/staff/files.js";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Read the entries of a stored (uncompressed) zip by walking its local headers. */
function unzip(buf: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  while (dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const size = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extra = dv.getUint16(o + 28, true);
    const name = text(buf.slice(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extra;
    const data = buf.slice(start, start + size);
    out.set(name, method === 0 ? text(data) : text(inflateRawSync(data)));
    o = start + size;
  }
  return out;
}

describe("staff export files", () => {
  it("writes CSV that spreadsheets can't run as formulas", () => {
    const bytes = toCsv(["Name", "Amount"], [["=HYPERLINK(\"http://x\")", "160.00"], ["O'Brien, Pat", "-12.50"], ["@cmd", null]]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, so Excel reads names correctly
    const csv = text(bytes);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",160.00`);
    expect(csv).toContain(`"O'Brien, Pat",-12.50`); // a negative number stays a number
    expect(csv).toContain(`"'@cmd",`);
  });

  it("quotes every text cell, so a ';' list separator can't split one into a formula", () => {
    const csv = text(toCsv(["Name"], [['Bob;=HYPERLINK("https://evil","Open")'], ["Plain"]]));
    expect(csv).toContain(`"Bob;=HYPERLINK(""https://evil"",""Open"")"`);
    expect(csv).toContain(`"Plain"`);
  });

  it("writes a valid .xlsx (zip) with numbers as numbers", () => {
    const x = toXlsx("Attendance", ["Acme — Attendance"], ["Employee", "Hours"], [[{ t: "text", v: "Jane & <Co>" }, { t: "number", v: "7.75" }]]);
    expect(text(x.slice(0, 2))).toBe("PK");
    const files = unzip(x);
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml", "xl/styles.xml"]);
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("Jane &amp; &lt;Co&gt;");
    expect(sheet).toMatch(/<c r="B4" s="2"><v>7\.75<\/v><\/c>/);
  });

  it("zips with correct CRCs (readable by standard tools)", () => {
    const z = zipStore([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(14, true)).toBe(0x3610a686); // crc32("hello")
  });

  it("writes a PDF with a correct cross-reference table", () => {
    const doc = new PdfDoc();
    doc.text(48, doc.y, "Payslip — José Müller (100%)", { size: 12, bold: true });
    doc.table([{ label: "Item", width: 200 }, { label: "Amount", width: 100, numeric: true }], Array.from({ length: 120 }, (_, i) => [`Line ${i}`, "1.00"]));
    const bytes = doc.toBytes({ title: "Test" });
    const s = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    // Several pages, and every xref offset points at its object.
    expect((s.match(/\/Type \/Page /g) ?? []).length).toBeGreaterThan(1);
    const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...s.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // Latin-1 characters survive (WinAnsi), parentheses are escaped.
    expect(s).toContain("Jos\\351 M\\374ller \\(100%\\)");
  });
});
