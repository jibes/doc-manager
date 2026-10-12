/**
 * Synthetic documents with known ground truth, for the end-to-end harness
 * (e2e/scan/run.mjs). Browser only: text is laid out with canvas fonts.
 *
 * A document is a list of drawing operations in millimetres. Text operations
 * carry their string (the OCR ground truth, in reading order) and are also
 * drawn into a "text mask" (all text in black, nothing else) that the ink
 * metrics compare the scan against. Regions whose colour must survive the
 * Document filter, and light tints that must not turn into dark blocks, are
 * listed separately.
 */

export type Rect = [x: number, y: number, w: number, h: number];

export interface TextOp {
  kind: 'text';
  text: string;
  /** Baseline start, mm. */
  x: number;
  y: number;
  /** Font size, mm (1 pt = 0.3528 mm). */
  size: number;
  family: string;
  weight?: string;
  style?: string;
  color?: string;
  align?: CanvasTextAlign;
  /** Radians, about (x, y). */
  rotate?: number;
  /** Handwriting simulation: per-glyph jitter, seeded. */
  hand?: number;
  /** Part of the OCR ground truth (default true). */
  ocr?: boolean;
  /** Part of the black-text mask used for ink recall (default true). */
  mask?: boolean;
  /** Light text on a dark ground: measured with its own mask, not as black ink. */
  reversed?: boolean;
  /** Text printed over colour, for the "text over colour" OCR recall. */
  zone?: 'colour';
}

export interface DrawOp {
  kind: 'draw';
  /** Drawn with the context scaled to millimetres. */
  draw: (g: CanvasRenderingContext2D) => void;
}

export type Op = TextOp | DrawOp;

export interface DocSpec {
  id: string;
  title: string;
  widthMm: number;
  heightMm: number;
  paper: string;
  ops: Op[];
  /** Coloured content that the Document filter should keep in colour. */
  colours: { name: string; rect: Rect }[];
  /** Light fills that should stay light (white or a light tint) in Document. */
  tints: { name: string; rect: Rect }[];
  /** Photographs: should stay photographic (not thresholded, posterised or hollowed). */
  photos?: { name: string; rect: Rect }[];
  /** Coloured paper / grounds: reported as kept or turned white, per filter. */
  grounds?: { name: string; rect: Rect }[];
  /** Expected PDF paper format, or null for a non-standard size. */
  format: 'A4' | 'Letter' | null;
  /** Characters whose survival through OCR + text layer is checked. */
  special?: string;
}

/* ---------------------------------------------------------- utilities ---- */

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PT = 0.3528;
const measure = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return (text: string, font: string): number => {
    ctx ??= document.createElement('canvas').getContext('2d')!;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
})();

/** Canvas font string for a text op at `pxPerMm`. */
export function fontOf(op: TextOp, pxPerMm: number): string {
  return `${op.style ?? 'normal'} ${op.weight ?? 'normal'} ${op.size * pxPerMm}px ${op.family}`;
}

/** Width of a string in mm. */
export function textWidth(text: string, size: number, family: string, weight = 'normal'): number {
  return measure(text, `normal ${weight} ${size * 10}px ${family}`) / 10;
}

class Builder {
  ops: Op[] = [];
  colours: DocSpec['colours'] = [];
  tints: DocSpec['tints'] = [];
  photos: NonNullable<DocSpec['photos']> = [];
  grounds: NonNullable<DocSpec['grounds']> = [];

  text(
    text: string,
    x: number,
    y: number,
    size: number,
    family: string,
    extra: Partial<TextOp> = {},
  ) {
    this.ops.push({ kind: 'text', text, x, y, size, family, ...extra });
  }

  draw(draw: (g: CanvasRenderingContext2D) => void) {
    this.ops.push({ kind: 'draw', draw });
  }

  /** Word-wrapped paragraph; returns the y of the next line. */
  para(
    text: string,
    x: number,
    y: number,
    width: number,
    size: number,
    family: string,
    lead = 1.35,
    extra: Partial<TextOp> = {},
  ): number {
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && textWidth(next, size, family, extra.weight) > width) {
        this.text(line, x, y, size, family, extra);
        y += size * lead;
        line = w;
      } else line = next;
    }
    if (line) {
      this.text(line, x, y, size, family, extra);
      y += size * lead;
    }
    return y;
  }

  rect(r: Rect, fill: string) {
    this.draw((g) => {
      g.fillStyle = fill;
      g.fillRect(...r);
    });
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, color = '#222') {
    this.draw((g) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    });
  }

  done(meta: Omit<DocSpec, 'ops' | 'colours' | 'tints' | 'photos' | 'grounds'>): DocSpec {
    return {
      ...meta,
      ops: this.ops,
      colours: this.colours,
      tints: this.tints,
      photos: this.photos,
      grounds: this.grounds,
    };
  }
}

const SERIF = '"Liberation Serif", serif';
const SANS = '"Liberation Sans", Arial, sans-serif';
const MONO = '"DejaVu Sans Mono", "Liberation Mono", monospace';
const CARLITO = 'Carlito, "Liberation Sans", sans-serif';
const CHARTER = '"Bitstream Charter", "Liberation Serif", serif';

const EN = [
  'Thank you for your letter of 14 September regarding the renewal of the maintenance agreement for the laboratory equipment at our Hamburg site.',
  'We have reviewed the proposed terms and are pleased to confirm that the annual inspection, calibration of all balances and the replacement of worn seals will be included at no additional cost.',
  'Please note that the new service window begins on the first working day of November and that our technicians will require access to the basement storage rooms between eight and ten in the morning.',
  'Should any of the instruments fail between scheduled visits, our support line remains available around the clock and a replacement unit can usually be delivered within two business days.',
  'We would be grateful if you could sign and return the enclosed copy of the agreement by the end of the month so that the purchase order can be issued in time.',
];

const CONTRACT = [
  '1. Scope. The Supplier shall provide the services described in Schedule A in accordance with the service levels set out in Schedule B and with all applicable laws and regulations.',
  '2. Term. This Agreement commences on the Effective Date and continues for an initial term of thirty-six months, after which it renews automatically for successive periods of twelve months unless either party gives written notice of termination no later than ninety days before the end of the then current term.',
  '3. Fees. The Customer shall pay the fees set out in Schedule C within thirty days of receipt of a correct invoice. Late payments bear interest at the statutory rate. All fees are exclusive of value added tax, which shall be charged in addition at the applicable rate.',
  '4. Confidentiality. Each party shall keep confidential all information disclosed by the other party and shall not use such information except for the purposes of this Agreement. This obligation survives termination for a period of five years.',
  '5. Liability. Neither party limits its liability for death or personal injury caused by negligence, for fraud, or for any liability that cannot be limited by law. Subject to the foregoing, the total liability of either party shall not exceed the fees paid in the twelve months preceding the claim.',
  '6. Data protection. The parties shall comply with their obligations under the applicable data protection legislation. Where the Supplier processes personal data on behalf of the Customer, the data processing terms in Schedule D apply.',
  '7. Governing law. This Agreement is governed by the laws of the Federal Republic of Germany. The courts of Munich shall have exclusive jurisdiction over any dispute arising out of or in connection with it.',
];

const ARTICLE = [
  'Abstract. We study the recovery of planar documents photographed with handheld cameras under uncontrolled illumination. Our method estimates the page boundary with a compact heatmap network and refines the corners against image gradients.',
  'Introduction. Mobile document capture has replaced the flatbed scanner for many everyday tasks such as filing receipts, signing contracts and archiving letters. Unlike a scanner, a phone sees the page under perspective, with shadows, uneven lighting and motion.',
  'Related work. Classical approaches detect the page outline with edge detectors and the Hough transform, which fails on cluttered backgrounds and low contrast. Learned detectors regress the corners directly or predict segmentation masks.',
  'Method. Given an input photograph we resize it to a fixed resolution and predict four heatmaps, one per corner. The peak of each heatmap gives a coarse estimate that is subsequently refined at full resolution by searching for the strongest gradient along the normal of each side.',
  'Illumination. Shadows cast by the hand and the phone are removed by estimating a smooth paper surface with a morphological closing and dividing the image by it. The result is thresholded relative to the local ink level.',
  'Experiments. We evaluate on five hundred synthetic photographs covering twenty document types and report corner error, character error rate and output size. The median corner error is below two pixels at full resolution.',
  'Conclusion. Careful geometry and photometric normalisation matter more than model size. Future work includes dewarping curled pages and detecting the reading orientation automatically.',
];

const DE = [
  'Sehr geehrte Frau Müller,',
  'vielen Dank für Ihre Anfrage vom 3. März. Gerne bestätigen wir Ihnen die Übernahme der Kosten für die Reparatur der Heizungsanlage in Höhe von 1.284,50 € (inkl. 19 % MwSt.).',
  'Bitte beachten Sie: Die Arbeiten beginnen am Montag – vorausgesetzt, das Wetter spielt mit – und dauern voraussichtlich zwei Wochen. Für Rückfragen steht Ihnen Herr Größmann gern zur Verfügung.',
  'Wie bereits besprochen, gilt die „Vereinbarung über Wartungsleistungen“ unverändert weiter; die Frist für Einwände endet am 30. September … danach ist die Rechnung fällig.',
  'Der Begriff ‘Pauschale’ umfasst sämtliche Nebenkosten — Anfahrt, Material und Entsorgung. Äußerst dringende Fälle werden außerhalb der Geschäftszeiten mit einem Zuschlag von 45 € berechnet.',
  'Mit freundlichen Grüßen',
];

/* ------------------------------------------------------------ documents ---- */

function letter(id: string, title: string, opts: { color?: string; paper?: string } = {}): DocSpec {
  const b = new Builder();
  const ink = opts.color ?? '#141414';
  const s = 11 * PT;
  b.text('Nordwind Analytics GmbH', 25, 30, 16 * PT, SERIF, { weight: 'bold', color: ink });
  b.text('Hafenstraße 18 · 20457 Hamburg · Tel. 040 555 0192', 25, 36, 8.5 * PT, SERIF, {
    color: ink,
  });
  b.text('Dr. Helen Carter', 25, 58, s, SERIF, { color: ink });
  b.text('Carter Laboratory Services Ltd', 25, 63, s, SERIF, { color: ink });
  b.text('42 Riverside Road', 25, 68, s, SERIF, { color: ink });
  b.text('Cambridge CB4 1QT', 25, 73, s, SERIF, { color: ink });
  b.text('Hamburg, 2 October 2026', 185, 90, s, SERIF, { align: 'right', color: ink });
  b.text('Maintenance agreement 2026/27, reference MA-7731', 25, 104, s, SERIF, {
    weight: 'bold',
    color: ink,
  });
  let y = 116;
  b.text('Dear Dr. Carter,', 25, y, s, SERIF, { color: ink });
  y += 9;
  for (const p of EN.slice(0, 5)) y = b.para(p, 25, y, 160, s, SERIF, 1.45, { color: ink }) + 4;
  b.text('Yours sincerely,', 25, y + 4, s, SERIF, { color: ink });
  b.text('Jonas Albrecht, Head of Service', 25, y + 24, s, SERIF, { color: ink });
  return b.done({
    id,
    title,
    widthMm: 210,
    heightMm: 297,
    paper: opts.paper ?? '#fbfaf6',
    format: 'A4',
  });
}

function invoice(
  id = 'invoice',
  title = 'Invoice: table, logo, red stamp, blue signature',
): DocSpec {
  const b = new Builder();
  // Logo.
  b.draw((g) => {
    g.fillStyle = '#1f6fd1';
    g.beginPath();
    g.arc(32, 30, 11, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f2a900';
    g.fillRect(47, 20, 38, 6);
  });
  b.colours.push(
    { name: 'logo-blue', rect: [21, 19, 22, 22] },
    { name: 'logo-orange', rect: [47, 20, 38, 6] },
  );
  b.text('ACME Instruments GmbH', 47, 36, 15 * PT, SANS, { weight: 'bold' });
  b.text('INVOICE', 185, 30, 20 * PT, SANS, { weight: 'bold', align: 'right' });
  b.text('No. 2026-10-0417', 185, 38, 10 * PT, SANS, { align: 'right' });
  b.text('Date: 07.10.2026', 185, 44, 10 * PT, SANS, { align: 'right' });
  b.text('Bill to: Riverside Clinic, 8 Mill Lane, Oxford OX1 2JD', 25, 60, 10 * PT, SANS);
  b.text('Customer ID: C-55821   Order: PO-99310', 25, 66, 10 * PT, SANS);
  // Table.
  const cols = [25, 40, 120, 145, 185];
  const rows = [
    ['Pos', 'Description', 'Qty', 'Amount'],
    ['1', 'Precision balance XS205', '2', '4,380.00'],
    ['2', 'Calibration weight set E2', '1', '1,215.50'],
    ['3', 'Draft shield, large', '2', '318.00'],
    ['4', 'Service contract, 12 months', '1', '960.00'],
    ['5', 'Shipping and insurance', '1', '85.00'],
  ];
  const top = 78;
  const rh = 9;
  b.rect([25, top, 160, rh], '#e4e4e4');
  b.tints.push({ name: 'table-header', rect: [25, top, 160, rh] });
  rows.forEach((r, i) => {
    const y = top + i * rh + 6.2;
    const size = 9.5 * PT;
    const weight = i === 0 ? 'bold' : 'normal';
    b.text(r[0], cols[0] + 2, y, size, SANS, { weight });
    b.text(r[1], cols[1] + 2, y, size, SANS, { weight });
    b.text(r[2], cols[3] - 3, y, size, SANS, { weight, align: 'right' });
    b.text(r[3], cols[4] - 2, y, size, SANS, { weight, align: 'right' });
  });
  for (let i = 0; i <= rows.length; i++) b.line(25, top + i * rh, 185, top + i * rh, 0.25);
  for (const x of cols) b.line(x, top, x, top + rows.length * rh, 0.25);
  const ty = top + rows.length * rh + 10;
  b.text('Net total', 145, ty, 10 * PT, SANS, { align: 'right' });
  b.text('6,958.50', 183, ty, 10 * PT, SANS, { align: 'right' });
  b.text('VAT 19%', 145, ty + 6, 10 * PT, SANS, { align: 'right' });
  b.text('1,322.12', 183, ty + 6, 10 * PT, SANS, { align: 'right' });
  b.text('Total due EUR', 145, ty + 13, 11 * PT, SANS, { align: 'right', weight: 'bold' });
  b.text('8,280.62', 183, ty + 13, 11 * PT, SANS, { align: 'right', weight: 'bold' });
  b.para(
    'Payment within 14 days without deduction to IBAN DE89 3704 0044 0532 0130 00, BIC COBADEFFXXX, quoting the invoice number. Goods remain our property until paid in full.',
    25,
    ty + 30,
    160,
    9 * PT,
    SANS,
  );
  // Red stamp.
  b.draw((g) => {
    g.save();
    g.translate(150, 230);
    g.rotate(-0.22);
    g.strokeStyle = 'rgba(200, 20, 40, 0.85)';
    g.lineWidth = 1.2;
    g.strokeRect(-30, -11, 60, 22);
    g.restore();
  });
  b.text('PAID', 150 + 0, 230 + 3.8, 11, SANS, {
    weight: 'bold',
    color: 'rgba(200, 20, 40, 0.85)',
    align: 'center',
    rotate: -0.22,
    mask: false,
    ocr: false,
  });
  b.colours.push({ name: 'stamp-red', rect: [118, 212, 64, 36] });
  // Blue signature.
  b.draw((g) => {
    g.strokeStyle = '#1b3fae';
    g.lineWidth = 0.6;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(28, 245);
    for (let i = 0; i < 80; i++) {
      const t = i / 79;
      g.lineTo(28 + t * 60, 245 - Math.sin(t * 15) * 5 - t * 4 + Math.cos(t * 41) * 1.5);
    }
    g.stroke();
  });
  b.colours.push({ name: 'signature-blue', rect: [27, 234, 63, 18] });
  b.line(25, 255, 95, 255, 0.2);
  b.text('Authorised signature', 25, 260, 8 * PT, SANS);
  b.text(
    'ACME Instruments GmbH · Registered office Berlin · HRB 123456 · VAT DE123456789',
    105,
    285,
    7 * PT,
    SANS,
    {
      align: 'center',
      color: '#555',
    },
  );
  return b.done({ id, title, widthMm: 210, heightMm: 297, paper: '#fcfbf7', format: 'A4' });
}

function receipt(): DocSpec {
  const b = new Builder();
  const s = 3.0;
  const lines: [string, string][] = [
    ['', 'SUPERMARKT FRISCH & GUT'],
    ['', 'Bahnhofstr. 5, 80335 Muenchen'],
    ['', 'Tel. 089 1234567'],
    ['', ''],
    ['Bio Vollmilch 1L', '1.29'],
    ['Roggenbrot 750g', '2.49'],
    ['Aepfel Elstar 1kg', '2.99'],
    ['Kaffee Crema 500g', '6.79'],
    ['Butter 250g', '2.19'],
    ['Joghurt Natur 3x', '1.77'],
    ['Tomaten Rispe', '1.85'],
    ['Pfand', '0.25'],
    ['Mineralwasser 6x1.5L', '3.54'],
    ['Spaghetti 500g', '0.99'],
    ['Olivenoel 0.75L', '7.49'],
    ['Zahnpasta', '1.45'],
    ['', ''],
    ['SUMME EUR', '33.09'],
    ['Gegeben Karte', '33.09'],
    ['', ''],
    ['MwSt 7%  netto 21.31', '1.49'],
    ['MwSt 19% netto  8.70', '1.65'],
    ['', ''],
    ['', '06.10.2026  18:42  Kasse 3'],
    ['', 'Bon 4471  Bediener 12'],
    ['', 'Vielen Dank fuer Ihren Einkauf!'],
  ];
  let y = 16;
  lines.forEach(([left, right], i) => {
    // Thermal print fades unevenly: a grey that varies down the slip.
    const grey = Math.round(100 + 35 * Math.sin(i * 0.37));
    const color = `rgb(${grey},${grey},${grey + 4})`;
    if (!left && right) b.text(right, 40, y, s, MONO, { align: 'center', color });
    else if (left) {
      b.text(left, 6, y, s, MONO, { color });
      b.text(right, 74, y, s, MONO, { align: 'right', color });
    }
    y += s * 1.6;
  });
  b.draw((g) => {
    // Barcode.
    const r = rng(5);
    g.fillStyle = '#555';
    for (let x = 14; x < 66; x += 0.9) if (r() > 0.45) g.fillRect(x, y + 4, 0.5 + r() * 0.4, 14);
  });
  return b.done({
    id: 'receipt',
    title: 'Thermal receipt, long and narrow, faint grey print',
    widthMm: 80,
    heightMm: y + 26,
    paper: '#f3f1ec',
    format: null,
  });
}

function contract(): DocSpec {
  const b = new Builder();
  const s = 7 * PT;
  b.text('SERVICE AGREEMENT', 105, 22, 12 * PT, SERIF, { weight: 'bold', align: 'center' });
  let y = 32;
  for (let k = 0; k < 2; k++)
    for (const p of CONTRACT) y = b.para(p, 18, y, 174, s, SERIF, 1.3) + 1.5;
  b.text(
    'Signed for the Supplier ____________________   Signed for the Customer ____________________',
    18,
    y + 10,
    s,
    SERIF,
  );
  return b.done({
    id: 'contract',
    title: 'Small-print contract (7 pt)',
    widthMm: 210,
    heightMm: 297,
    paper: '#fbfaf7',
    format: 'A4',
  });
}

function handwritten(): DocSpec {
  const b = new Builder();
  b.draw((g) => {
    g.strokeStyle = '#9ec3e6';
    g.lineWidth = 0.25;
    for (let y = 30; y < 290; y += 8) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(210, y);
      g.stroke();
    }
    g.strokeStyle = '#e88';
    g.beginPath();
    g.moveTo(25, 0);
    g.lineTo(25, 297);
    g.stroke();
  });
  const lines = [
    'Notes for Tuesday',
    'Call the plumber about the leak',
    'Pick up the parcel at the post office',
    'Buy milk, eggs, bread and coffee',
    'Ask Anna about the weekend plans',
    'Pay the electricity bill by Friday',
    'Book the dentist for next month',
    'Return the library books',
  ];
  lines.forEach((t, i) => {
    b.text(t, 30, 37.5 + i * 16, 6.5, '"DejaVu Serif", serif', {
      style: 'italic',
      color: '#1a2f8a',
      hand: 11 + i,
    });
  });
  b.colours.push({ name: 'ink-blue', rect: [30, 30, 150, 125] });
  return b.done({
    id: 'handwritten',
    title: 'Handwriting-style note on ruled paper (blue ink)',
    widthMm: 210,
    heightMm: 297,
    paper: '#fdfdfb',
    format: 'A4',
  });
}

function form(): DocSpec {
  const b = new Builder();
  b.text('Application for a Parking Permit', 20, 25, 15 * PT, SANS, { weight: 'bold' });
  b.rect([20, 30, 170, 10], '#dfeaf7');
  b.tints.push({ name: 'blue-band', rect: [20, 30, 170, 10] });
  b.text('Section 1: Applicant', 23, 36.8, 10 * PT, SANS, { weight: 'bold', color: '#234' });
  const fields: [string, string][] = [
    ['Surname', 'Whitfield'],
    ['First name', 'Margaret'],
    ['Street and number', '27 Orchard Close'],
    ['Postcode and town', 'BS8 4PL Bristol'],
    ['Vehicle registration', 'WX19 KTB'],
  ];
  let y = 46;
  for (const [label, value] of fields) {
    b.text(label, 22, y + 4, 7.5 * PT, SANS, { color: '#666' });
    b.rect([70, y, 120, 8], '#eeeeee');
    b.text(value, 72, y + 5.8, 10 * PT, MONO);
    y += 11;
  }
  b.tints.push({ name: 'grey-fields', rect: [70, 46, 120, 52] });
  b.rect([20, y + 2, 170, 10], '#dfeaf7');
  b.text('Section 2: Permit type', 23, y + 8.8, 10 * PT, SANS, { weight: 'bold', color: '#234' });
  y += 18;
  const boxes = ['Resident', 'Visitor', 'Business', 'Carer'];
  boxes.forEach((t, i) => {
    const x = 22 + i * 42;
    const by = y;
    b.draw((g) => {
      g.strokeStyle = '#333';
      g.lineWidth = 0.3;
      g.strokeRect(x, by, 4, 4);
      if (i === 0) {
        g.beginPath();
        g.moveTo(x + 0.6, by + 2);
        g.lineTo(x + 1.8, by + 3.4);
        g.lineTo(x + 3.6, by + 0.5);
        g.stroke();
      }
    });
    b.text(t, x + 6, y + 3.5, 9 * PT, SANS);
  });
  y += 14;
  b.rect([20, y, 170, 40], '#f6f3e8');
  b.tints.push({ name: 'cream-box', rect: [20, y, 170, 40] });
  let py = y + 7;
  py = b.para(
    'Declaration. I confirm that the information given above is correct and complete. I understand that a permit issued on the basis of false information will be withdrawn and that the fee is not refundable.',
    23,
    py,
    164,
    9 * PT,
    SANS,
  );
  // Highlighter over one sentence.
  const hy = py + 2;
  b.draw((g) => {
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = 'rgba(255, 238, 0, 0.55)';
    g.fillRect(22, hy - 3.6, 120, 5);
    g.restore();
  });
  b.text('The permit must be displayed clearly behind the windscreen.', 23, hy, 9 * PT, SANS);
  b.colours.push({ name: 'highlighter', rect: [22, hy - 3.6, 120, 5] });
  y += 50;
  b.text('Office use only', 22, y, 8 * PT, SANS, { color: '#888' });
  b.rect([20, y + 3, 170, 22], '#f0f0f0');
  b.tints.push({ name: 'office-grey', rect: [20, y + 3, 170, 22] });
  b.text('Received:', 23, y + 10, 8 * PT, SANS, { color: '#777' });
  b.text('Permit no.:', 100, y + 10, 8 * PT, SANS, { color: '#777' });
  b.text(
    'Form PP-2 (rev. 03/2026). Please return to the Parking Services office, Room 1.14.',
    20,
    285,
    7 * PT,
    SANS,
    {
      color: '#666',
    },
  );
  return b.done({
    id: 'form',
    title: 'Form: grey boxes, light tints, highlighter, grey labels',
    widthMm: 210,
    heightMm: 297,
    paper: '#fdfdfc',
    format: 'A4',
  });
}

function brochure(): DocSpec {
  const b = new Builder();
  b.draw((g) => {
    // A procedural "photo": sky, sun, hills, a lake, with texture.
    const sky = g.createLinearGradient(0, 0, 0, 120);
    sky.addColorStop(0, '#2a6fdb');
    sky.addColorStop(1, '#a8d4f5');
    g.fillStyle = sky;
    g.fillRect(0, 0, 210, 120);
    g.fillStyle = '#ffd34d';
    g.beginPath();
    g.arc(160, 35, 14, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3f8f3a';
    g.beginPath();
    g.moveTo(0, 90);
    for (let x = 0; x <= 210; x += 5) g.lineTo(x, 80 - 18 * Math.sin(x / 31) - 6 * Math.sin(x / 9));
    g.lineTo(210, 120);
    g.lineTo(0, 120);
    g.fill();
    g.fillStyle = '#2b6ea3';
    g.fillRect(0, 100, 210, 20);
    const r = rng(9);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = `rgba(${(r() * 255) | 0},${(r() * 255) | 0},${(r() * 255) | 0},0.08)`;
      g.fillRect(r() * 210, r() * 120, 1.2, 1.2);
    }
  });
  b.colours.push(
    { name: 'photo-sky', rect: [10, 5, 120, 40] },
    { name: 'photo-grass', rect: [10, 85, 190, 10] },
  );
  b.text('Discover the Lakes', 15, 140, 24 * PT, SANS, { weight: 'bold', color: '#c2185b' });
  b.colours.push({ name: 'headline-magenta', rect: [14, 130, 120, 13] });
  const body = [
    'Three days of guided walks, boat trips and regional cuisine in one of the most beautiful landscapes of the north. Our small groups of at most twelve guests are accompanied by local guides who know every path.',
    'Accommodation is in family run guesthouses with breakfast. Transfers from the railway station are included, as are all entrance fees and a farewell dinner on the last evening.',
  ];
  let y = 152;
  y = b.para(body[0], 15, y, 85, 9.5 * PT, CARLITO, 1.4);
  let y2 = 152;
  y2 = b.para(body[1], 110, y2, 85, 9.5 * PT, CARLITO, 1.4);
  const by = Math.max(y, y2) + 8;
  b.rect([15, by, 85, 40], '#ffe9c7');
  b.rect([110, by, 85, 40], '#d9f0e3');
  b.text('From 389 EUR per person', 20, by + 12, 11 * PT, CARLITO, {
    weight: 'bold',
    color: '#7a3b00',
  });
  b.text('Book by 31 January', 115, by + 12, 11 * PT, CARLITO, {
    weight: 'bold',
    color: '#0b5d34',
  });
  b.colours.push(
    { name: 'orange-box', rect: [15, by, 85, 40] },
    { name: 'green-box', rect: [110, by, 85, 40] },
  );
  b.text('www.lakes-example.travel  ·  +44 20 7946 0000', 105, 285, 9 * PT, CARLITO, {
    align: 'center',
  });
  return b.done({
    id: 'brochure',
    title: 'Colour brochure with photo',
    widthMm: 210,
    heightMm: 297,
    paper: '#ffffff',
    format: 'A4',
  });
}

function idCard(): DocSpec {
  const b = new Builder();
  b.draw((g) => {
    const grad = g.createLinearGradient(0, 0, 85.6, 54);
    grad.addColorStop(0, '#d7eef0');
    grad.addColorStop(1, '#f4e7d6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 85.6, 54);
    g.strokeStyle = 'rgba(60,120,140,0.25)';
    g.lineWidth = 0.15;
    for (let i = 0; i < 40; i++) {
      g.beginPath();
      g.arc(70, 40, 4 + i * 1.3, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#1d5e8c';
    g.fillRect(0, 0, 85.6, 9);
    // Portrait.
    g.fillStyle = '#c9b8a6';
    g.fillRect(5, 14, 22, 28);
    g.fillStyle = '#8b6b52';
    g.beginPath();
    g.arc(16, 24, 6, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(16, 40, 10, 8, 0, Math.PI, 0);
    g.fill();
  });
  b.text('MEMBER CARD', 5, 6.3, 3.6, SANS, { weight: 'bold', color: '#ffffff', mask: false });
  b.colours.push(
    { name: 'card-header', rect: [0, 0, 85.6, 9] },
    { name: 'portrait', rect: [5, 14, 22, 28] },
  );
  b.text('Name', 31, 16, 1.8, SANS, { color: '#555' });
  b.text('ELENA RODRIGUEZ', 31, 20.5, 3.0, SANS, { weight: 'bold' });
  b.text('Member no.', 31, 26, 1.8, SANS, { color: '#555' });
  b.text('7704 2219 0385', 31, 30.5, 3.0, MONO);
  b.text('Valid until', 31, 36, 1.8, SANS, { color: '#555' });
  b.text('12/2028', 31, 40.5, 3.0, SANS);
  b.text('Library and Sports Association', 31, 48.5, 2.2, SANS);
  return b.done({
    id: 'idcard',
    title: 'ID-card-sized card (85.6 x 54 mm)',
    widthMm: 85.6,
    heightMm: 54,
    paper: '#eef5f2',
    format: null,
  });
}

function usLetter(): DocSpec {
  const b = new Builder();
  const s = 11 * PT;
  b.text('MEMORANDUM', 25.4, 30, 18 * PT, SANS, { weight: 'bold' });
  b.text('To: All department heads', 25.4, 42, s, SANS);
  b.text('From: Facilities Office', 25.4, 48, s, SANS);
  b.text('Date: October 2, 2026', 25.4, 54, s, SANS);
  b.text('Subject: Building maintenance schedule', 25.4, 60, s, SANS, { weight: 'bold' });
  b.line(25.4, 64, 190.5, 64, 0.4);
  let y = 74;
  for (const p of EN.slice(1, 5)) y = b.para(p, 25.4, y, 165, s, SANS, 1.5) + 4;
  b.text('Questions may be directed to extension 4410.', 25.4, y + 4, s, SANS);
  return b.done({
    id: 'us_letter',
    title: 'US Letter memo',
    widthMm: 215.9,
    heightMm: 279.4,
    paper: '#fbfbf8',
    format: 'Letter',
  });
}

function landscape(): DocSpec {
  const b = new Builder();
  b.text('Quarterly Sales Report Q3 2026', 20, 22, 16 * PT, SANS, { weight: 'bold' });
  const head = ['Region', 'July', 'August', 'September', 'Total', 'Change'];
  const data = [
    ['North', '12,400', '13,150', '14,020', '39,570', '+6.2%'],
    ['South', '9,870', '9,640', '10,210', '29,720', '+1.9%'],
    ['East', '15,300', '15,910', '16,480', '47,690', '+4.4%'],
    ['West', '8,450', '8,120', '8,990', '25,560', '-0.8%'],
    ['Central', '11,020', '11,760', '12,300', '35,080', '+5.1%'],
    ['Online', '21,400', '23,900', '25,100', '70,400', '+12.7%'],
  ];
  const xs = [20, 75, 120, 165, 215, 255];
  const top = 34;
  b.rect([20, top, 257, 9], '#d8e3f0');
  b.tints.push({ name: 'header-band', rect: [20, top, 257, 9] });
  [head, ...data].forEach((row, i) => {
    const y = top + 6.3 + i * 10;
    row.forEach((cell, j) =>
      b.text(cell, xs[j], y, 10 * PT, SANS, { weight: i === 0 ? 'bold' : 'normal' }),
    );
    if (i > 0) b.line(20, top + 9 + i * 10, 277, top + 9 + i * 10, 0.15, '#999');
  });
  b.para(
    'Online sales continued to grow strongly and now account for almost a third of total revenue. The West region remains below target; a review of the distribution network is planned for November.',
    20,
    top + 85,
    250,
    10 * PT,
    SANS,
  );
  b.draw((g) => {
    const vals = [39.6, 29.7, 47.7, 25.6, 35.1, 70.4];
    const colors = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#b07aa1'];
    vals.forEach((v, i) => {
      g.fillStyle = colors[i];
      g.fillRect(30 + i * 40, 195 - v, 25, v);
    });
  });
  b.colours.push({ name: 'bars', rect: [30, 125, 230, 70] });
  return b.done({
    id: 'landscape',
    title: 'Landscape A4 report with table and bar chart',
    widthMm: 297,
    heightMm: 210,
    paper: '#ffffff',
    format: 'A4',
  });
}

function twoColumn(): DocSpec {
  const b = new Builder();
  b.text('Robust Capture of Planar Documents with Handheld Cameras', 105, 22, 14 * PT, CHARTER, {
    weight: 'bold',
    align: 'center',
  });
  b.text('A. Novak, L. Fischer and R. Okafor', 105, 29, 10 * PT, CHARTER, { align: 'center' });
  const s = 8.5 * PT;
  let y = 40;
  let col = 0;
  const x = [18, 110];
  for (let k = 0; k < 6; k++)
    for (const p of ARTICLE) {
      // Lay out word by word so the paragraph can continue in column 2.
      const words = p.split(' ');
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (line && textWidth(next, s, CHARTER) > 82) {
          b.text(line, x[col], y, s, CHARTER);
          y += s * 1.3;
          line = w;
          if (y > 282) {
            if (col === 1) return finishTwo(b);
            col = 1;
            y = 40;
          }
        } else line = next;
      }
      b.text(line, x[col], y, s, CHARTER);
      y += s * 1.3 + 1.5;
      if (y > 282) {
        if (col === 1) return finishTwo(b);
        col = 1;
        y = 40;
      }
    }
  return finishTwo(b);
}
function finishTwo(b: Builder): DocSpec {
  return b.done({
    id: 'two_column',
    title: 'Dense two-column article (8.5 pt)',
    widthMm: 210,
    heightMm: 297,
    paper: '#fcfcfa',
    format: 'A4',
  });
}

function german(): DocSpec {
  const b = new Builder();
  const s = 11 * PT;
  b.text('Stadtwerke Süd GmbH · Kundenservice', 25, 28, 13 * PT, SANS, { weight: 'bold' });
  b.text('Frau Jutta Müller', 25, 50, s, SANS);
  b.text('Weißdornweg 7', 25, 55, s, SANS);
  b.text('70173 Stuttgart', 25, 60, s, SANS);
  b.text('Stuttgart, 6. Oktober 2026', 185, 75, s, SANS, { align: 'right' });
  b.text('Ihre Anfrage – Kostenübernahme Heizungsreparatur', 25, 88, s, SANS, { weight: 'bold' });
  let y = 100;
  for (const p of DE) y = b.para(p, 25, y, 160, s, SANS, 1.5) + 4;
  b.text('Björn Weiß, Sachbearbeiter', 25, y + 14, s, SANS);
  return b.done({
    id: 'german',
    title: 'German letter: umlauts, ß, €, curly quotes, dashes, ellipsis',
    widthMm: 210,
    heightMm: 297,
    paper: '#fbfaf6',
    format: 'A4',
    special: 'äöüÄÖÜß€„“‘’–—…',
  });
}

/* ------------------------------------------------- colour and photos ---- */

/** A procedural photograph: sky, sun, hills, water, a dark shadowed area, grain. */
function drawPhoto(g: CanvasRenderingContext2D, r: Rect, seed: number, dark = false) {
  const [x, y, w, h] = r;
  const rnd = rng(seed);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const sky = g.createLinearGradient(0, y, 0, y + h * 0.6);
  sky.addColorStop(0, dark ? '#0b1a3a' : '#3b7bd8');
  sky.addColorStop(1, dark ? '#4a3a6a' : '#bfe0f7');
  g.fillStyle = sky;
  g.fillRect(x, y, w, h);
  g.fillStyle = dark ? '#f6e7a0' : '#ffd84d';
  g.beginPath();
  g.arc(x + w * 0.75, y + h * 0.25, h * 0.1, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dark ? '#14261a' : '#4c9a3f';
  g.beginPath();
  g.moveTo(x, y + h * 0.7);
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    g.lineTo(x + t * w, y + h * (0.6 - 0.12 * Math.sin(t * 7 + seed) - 0.05 * Math.sin(t * 23)));
  }
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.fill();
  // A dark shadowed foreground (rocks / a building) and a red object.
  g.fillStyle = dark ? '#050505' : '#2a2320';
  g.beginPath();
  g.ellipse(x + w * 0.2, y + h, w * 0.3, h * 0.28, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = '#c0392b';
  g.fillRect(x + w * 0.55, y + h * 0.62, w * 0.08, h * 0.16);
  for (let i = 0; i < (w * h) / 6; i++) {
    const v = rnd() * 255;
    g.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},0.07)`;
    g.fillRect(x + rnd() * w, y + rnd() * h, 0.6, 0.6);
  }
  g.restore();
}

function colouredPaper(id: string, title: string, paper: string): DocSpec {
  const doc = letter(id, title, { paper });
  doc.grounds = [{ name: 'paper', rect: [0, 0, doc.widthMm, doc.heightMm] }];
  for (const op of doc.ops) if (op.kind === 'text') op.zone = 'colour';
  return doc;
}

function flyer(id: string, title: string, ground: string, panel: string): DocSpec {
  const b = new Builder();
  b.rect([0, 0, 210, 297], ground);
  b.grounds.push({ name: 'ground', rect: [0, 0, 210, 297] });
  b.text('SUMMER CONCERT', 105, 45, 30 * PT, SANS, {
    weight: 'bold',
    color: '#ffffff',
    align: 'center',
    reversed: true,
    zone: 'colour',
  });
  b.text('Saturday 14 June, 7 pm, Old Town Hall', 105, 60, 14 * PT, SANS, {
    color: '#ffffff',
    align: 'center',
    reversed: true,
    zone: 'colour',
  });
  let y = 85;
  for (const p of EN.slice(0, 2))
    y =
      b.para(p, 25, y, 160, 11 * PT, SANS, 1.45, {
        color: '#ffffff',
        reversed: true,
        zone: 'colour',
      }) + 5;
  // A lighter panel with black text.
  const top = y + 5;
  b.rect([20, top, 170, 70], panel);
  b.grounds.push({ name: 'panel', rect: [20, top, 170, 70] });
  let py = top + 12;
  b.text('Tickets and information', 25, py, 13 * PT, SANS, { weight: 'bold', zone: 'colour' });
  py += 9;
  for (const p of EN.slice(3, 4))
    py = b.para(p, 25, py, 160, 11 * PT, SANS, 1.45, { zone: 'colour' });
  b.text('Box office: +49 30 1234 5678', 25, py + 4, 11 * PT, SANS, { zone: 'colour' });
  b.text('www.summer-concert.example', 105, 280, 12 * PT, SANS, {
    color: '#ffffff',
    align: 'center',
    reversed: true,
    zone: 'colour',
  });
  return b.done({ id, title, widthMm: 210, heightMm: 297, paper: '#ffffff', format: 'A4' });
}

function gradientPage(
  id: string,
  title: string,
  from: string,
  to: string,
  diagonal: boolean,
): DocSpec {
  const b = new Builder();
  b.draw((g) => {
    const grad = diagonal
      ? g.createLinearGradient(0, 0, 210, 297)
      : g.createLinearGradient(0, 0, 0, 297);
    grad.addColorStop(0, from);
    grad.addColorStop(1, to);
    g.fillStyle = grad;
    g.fillRect(0, 0, 210, 297);
  });
  b.grounds.push(
    { name: 'top', rect: [0, 0, 210, 40] },
    { name: 'middle', rect: [0, 130, 210, 40] },
    { name: 'bottom', rect: [0, 255, 210, 42] },
  );
  b.text('Annual Report 2026', 25, 35, 22 * PT, SERIF, { weight: 'bold', zone: 'colour' });
  let y = 55;
  for (let k = 0; k < 2; k++)
    for (const p of EN) y = b.para(p, 25, y, 160, 11 * PT, SERIF, 1.45, { zone: 'colour' }) + 4;
  return b.done({ id, title, widthMm: 210, heightMm: 297, paper: '#ffffff', format: 'A4' });
}

function bands(): DocSpec {
  const b = new Builder();
  b.rect([0, 0, 210, 32], '#1b2a4a');
  b.grounds.push({ name: 'header-navy', rect: [0, 0, 210, 32] });
  b.text('NORTHSIDE HOUSING CO-OP', 20, 20, 18 * PT, SANS, {
    weight: 'bold',
    color: '#ffffff',
    reversed: true,
    zone: 'colour',
  });
  b.text('Newsletter · October 2026', 190, 20, 10 * PT, SANS, {
    color: '#ffffff',
    align: 'right',
    reversed: true,
    zone: 'colour',
  });
  let y = 48;
  y = b.para(EN[0], 20, y, 170, 10.5 * PT, SANS, 1.45) + 4;
  // Callouts.
  b.rect([20, y, 80, 40], '#e3f2fd');
  b.grounds.push({ name: 'callout-lightblue', rect: [20, y, 80, 40] });
  b.para(
    'Meeting on Thursday at 7 pm in the community room. All members welcome.',
    24,
    y + 9,
    72,
    10 * PT,
    SANS,
    1.4,
    { color: '#0d2b45', zone: 'colour' },
  );
  b.rect([110, y, 80, 40], '#ff9800');
  b.grounds.push({ name: 'callout-orange', rect: [110, y, 80, 40] });
  b.colours.push({ name: 'callout-orange', rect: [110, y, 80, 40] });
  b.para(
    'Rent changes take effect on 1 January. Please check your new direct debit.',
    114,
    y + 9,
    72,
    10 * PT,
    SANS,
    1.4,
    { zone: 'colour' },
  );
  y += 50;
  b.rect([20, y, 170, 30], '#2e7d32');
  b.grounds.push({ name: 'callout-darkgreen', rect: [20, y, 170, 30] });
  b.para(
    'Garden day: bring gloves and a friend. Tools and lunch are provided by the committee.',
    25,
    y + 10,
    160,
    11 * PT,
    SANS,
    1.4,
    { color: '#ffffff', reversed: true, zone: 'colour' },
  );
  y += 42;
  for (const p of EN.slice(1, 4)) y = b.para(p, 20, y, 170, 10.5 * PT, SANS, 1.45) + 4;
  b.rect([0, 272, 210, 25], '#c62828');
  b.grounds.push({ name: 'footer-red', rect: [0, 272, 210, 25] });
  b.text(
    'Office: 12 Mill Street · Open Mon–Fri 9–17 · Tel. 0161 496 0000',
    105,
    287,
    10 * PT,
    SANS,
    { color: '#ffffff', align: 'center', reversed: true, zone: 'colour' },
  );
  return b.done({
    id: 'bands',
    title: 'Dark header/footer bands with white text, coloured callouts',
    widthMm: 210,
    heightMm: 297,
    paper: '#ffffff',
    format: 'A4',
  });
}

function photos(): DocSpec {
  const b = new Builder();
  const hero: Rect = [0, 0, 210, 105];
  b.draw((g) => drawPhoto(g, hero, 4));
  b.photos.push({ name: 'full-bleed', rect: hero });
  b.text('A Weekend in the Highlands', 20, 122, 20 * PT, SERIF, { weight: 'bold' });
  const inline: Rect = [20, 132, 55, 40];
  b.draw((g) => drawPhoto(g, inline, 9));
  b.photos.push({ name: 'inline-small', rect: inline });
  let y = 136;
  y = b.para(EN[0] + ' ' + EN[1], 82, y, 108, 10 * PT, SERIF, 1.45);
  y = Math.max(y, 178);
  y = b.para(EN[2], 20, y, 170, 10 * PT, SERIF, 1.45) + 3;
  const night: Rect = [20, y, 170, 60];
  b.draw((g) => drawPhoto(g, night, 13, true));
  b.photos.push({ name: 'dark-photo', rect: night });
  b.text('Night view over the loch, taken from the old bridge.', 20, y + 65, 9 * PT, SERIF, {
    style: 'italic',
  });
  b.para(EN[3], 20, y + 73, 170, 10 * PT, SERIF, 1.45);
  return b.done({
    id: 'photos',
    title: 'Embedded photos: full-bleed, inline, dark photo next to text',
    widthMm: 210,
    heightMm: 297,
    paper: '#fdfdfb',
    format: 'A4',
  });
}

function colouredText(): DocSpec {
  const b = new Builder();
  const heads: [string, string][] = [
    ['1. Project summary', '#c62828'],
    ['2. Budget overview', '#2e7d32'],
    ['3. Next steps', '#1565c0'],
  ];
  let y = 25;
  heads.forEach(([h, c], i) => {
    b.text(h, 20, y, 14 * PT, SANS, { weight: 'bold', color: c, mask: false, zone: 'colour' });
    b.colours.push({ name: `heading-${c}`, rect: [19, y - 6, 80, 8] });
    y += 8;
    y = b.para(EN[i], 20, y, 170, 10 * PT, SANS, 1.45) + 2;
    const link = `Details: https://intranet.example/projects/${i + 1}/report`;
    b.text(link, 20, y, 10 * PT, SANS, { color: '#1a0dab', mask: false, zone: 'colour' });
    const lw = textWidth(link, 10 * PT, SANS);
    b.line(20, y + 0.8, 20 + lw, y + 0.8, 0.2, '#1a0dab');
    b.colours.push({ name: `link-${i + 1}`, rect: [19, y - 4, lw + 2, 6] });
    y += 12;
  });
  // Table with thin coloured rules.
  const rows = [
    ['Item', 'Q1', 'Q2', 'Q3'],
    ['Staff', '42,000', '43,500', '44,100'],
    ['Equipment', '8,200', '3,100', '5,750'],
    ['Travel', '1,900', '2,400', '2,050'],
  ];
  const top = y;
  rows.forEach((r, i) => {
    r.forEach((c, j) =>
      b.text(c, 22 + j * 40, top + 6 + i * 8, 9.5 * PT, SANS, {
        weight: i === 0 ? 'bold' : 'normal',
      }),
    );
    b.line(20, top + 8 + i * 8, 180, top + 8 + i * 8, 0.18, '#4a90d9');
  });
  for (let j = 0; j <= 4; j++) b.line(20 + j * 40, top, 20 + j * 40, top + 32, 0.18, '#4a90d9');
  b.colours.push({ name: 'table-rules', rect: [19, top - 1, 162, 34] });
  // Line chart with thin coloured series.
  const cy = top + 45;
  b.draw((g) => {
    g.strokeStyle = '#888';
    g.lineWidth = 0.2;
    g.strokeRect(20, cy, 170, 50);
    const series: [string, number][] = [
      ['#e53935', 1],
      ['#43a047', 2],
      ['#1e88e5', 3],
    ];
    for (const [col, k] of series) {
      g.strokeStyle = col;
      g.lineWidth = 0.35;
      g.beginPath();
      for (let i = 0; i <= 20; i++) {
        const px = 20 + i * 8.5;
        const py = cy + 25 - 15 * Math.sin(i / 3 + k) * (0.5 + k * 0.2);
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.stroke();
    }
  });
  b.colours.push({ name: 'chart-lines', rect: [20, cy, 170, 50] });
  b.text('Figure 1. Monthly spend by category.', 20, cy + 57, 9 * PT, SANS, { style: 'italic' });
  b.para(EN[4], 20, cy + 66, 170, 10 * PT, SANS, 1.45);
  return b.done({
    id: 'coloured_text',
    title: 'Coloured headings and links, thin coloured table rules and chart',
    widthMm: 210,
    heightMm: 297,
    paper: '#fdfdfb',
    format: 'A4',
  });
}

/* ------------------------------------------------------------- registry ---- */

/**
 * A notice as pinned up at a bus stop or tourist office: two small logos,
 * dense text, a big blue rounded-rectangle logo and two ruled price tables
 * whose many long horizontal rules compete with the page's own edges.
 */
function notice(): DocSpec {
  const b = new Builder();
  const s = 9.5 * PT;
  // Small logos in the header.
  b.draw((g) => {
    g.strokeStyle = '#2d6db3';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(20, 24);
    g.quadraticCurveTo(30, 12, 42, 22);
    g.quadraticCurveTo(48, 18, 52, 24);
    g.stroke();
    g.beginPath();
    g.moveTo(20, 26);
    g.lineTo(52, 26);
    g.stroke();
    g.fillStyle = '#2d6db3';
    g.fillRect(156, 22, 30, 2.5);
  });
  b.colours.push(
    { name: 'header-logo', rect: [19, 11, 34, 16] },
    { name: 'header-bar', rect: [156, 22, 30, 2.5] },
  );
  b.text('Seenland', 22, 31, 7 * PT, SANS, { weight: 'bold' });
  b.text('Mobilität im Seenland', 105, 20, 9 * PT, SANS, { align: 'center' });
  b.text('Der Seenland Rufbus', 105, 27, 9 * PT, SANS, { align: 'center' });
  b.text('Kurort am See', 171, 18, 11 * PT, SERIF, { align: 'center', weight: 'bold' });
  b.text('Der Seenland Rufbus', 20, 46, 12 * PT, SANS, { weight: 'bold', color: '#1d4f91' });
  b.colours.push({ name: 'heading-blue', rect: [20, 41, 60, 6] });
  let y = 53;
  for (const p of [
    'Der Rufbus ergänzt den Linienverkehr im Seenland. Damit wird eine hohe Flexibilität der Mobilität geboten. Den Startpunkt und das Ziel Ihrer Fahrt bestimmen Sie innerhalb des Betriebsgebietes eigenständig.',
    'Fahrgäste mit ähnlichem Ziel teilen sich die Fahrt in einem Fahrzeug, somit kann das eigene Auto stehengelassen werden. So werden Abgasemissionen eingespart und die Straßen der Gemeinden entlastet.',
  ])
    y = b.para(p, 20, y, 170, s, SANS, 1.35) + 2;
  b.text('Telefon: +49 8841 555 0190', 30, y + 4, s, SANS);
  y += 12;
  b.text('Betriebsgebiet der Gemeinden', 20, y, s, SANS, { weight: 'bold' });
  for (const [i, town] of [
    'Uferdorf',
    'Hochried',
    'Seebruck',
    'Moosach',
    'Kirchberg',
    'Talheim',
    'Lindenau',
    'Weiherfeld',
  ].entries())
    b.text(town, 34, y + 5 + i * 4.2, s, SANS);
  // The big blue logo.
  const logo = y;
  b.draw((g) => {
    g.fillStyle = '#3a78c2';
    g.beginPath();
    g.roundRect(105, logo + 2, 75, 30, 4);
    g.fill();
  });
  b.text('RUFBUS', 142.5, y + 21, 18 * PT, SANS, {
    weight: 'bold',
    color: '#ffffff',
    align: 'center',
    reversed: true,
    zone: 'colour',
  });
  b.colours.push({ name: 'bus-logo', rect: [105, y + 2, 75, 30] });
  y += 46;
  // Two ruled price tables.
  const table = (top: number, head: [string, string, string], rows: string[][]) => {
    const rh = 4.6;
    const cols = [20, 75, 130, 185];
    b.text(head[0], cols[0] + 1, top - 1.5, 8.5 * PT, SANS, { weight: 'bold' });
    b.text(head[1], cols[1] + 1, top + rh - 1.2, 8.5 * PT, SANS, { weight: 'bold' });
    b.text(head[2], cols[2] + 1, top + rh - 1.2, 8.5 * PT, SANS, { weight: 'bold' });
    rows.forEach((r, i) => {
      const by = top + (i + 2) * rh - 1.2;
      b.text(r[0], cols[1] - 2, by, 8.5 * PT, SANS, { align: 'right' });
      b.text(r[1], cols[2] - 2, by, 8.5 * PT, SANS, { align: 'right' });
      b.text(r[2], cols[3] - 2, by, 8.5 * PT, SANS, { align: 'right' });
    });
    const n = rows.length + 1;
    for (let i = 0; i <= n; i++) b.line(cols[0], top + i * rh, cols[3], top + i * rh, 0.25);
    for (const x of cols) b.line(x, top, x, top + n * rh, 0.25);
    return top + n * rh;
  };
  const prices = [
    ['0-5 km', '2,50 €', '1,50 €'],
    ['5-10 km', '5,00 €', '2,50 €'],
    ['10-15 km', '7,50 €', '3,50 €'],
  ];
  y = table(y, ['Tarife', 'Einzelticket', 'Ermäßigt'], prices);
  b.text('+ 1,50 € je weiterer angefangener km', 20, y + 4, 8.5 * PT, SANS);
  y = table(
    y + 14,
    ['Gruppen', 'ab 3 Personen', 'Kinder'],
    [
      ['0-5 km', '6,00 €', '4,00 €'],
      ['5-10 km', '12,00 €', '7,00 €'],
      ['10-15 km', '16,00 €', '10,00 €'],
    ],
  );
  y += 12;
  y = b.para(
    'Kinder bis 6 Jahre fahren in Begleitung kostenlos. Fahrgäste mit Deutschlandticket fahren im Rahmen einer Buchung auf allen Strecken kostenlos.',
    20,
    y,
    170,
    s,
    SANS,
  );
  b.text('Betriebszeiten', 20, y + 6, s, SANS, { weight: 'bold' });
  b.text('Montag bis Sonntag     07.00 – 20.00 Uhr', 20, y + 11, s, SANS);
  b.text('Vorausbuchungen sind bis zu 7 Tage vor der Abholung möglich.', 20, y + 22, s, SANS);
  b.text('Gemeinde Kurort am See, Tourismus und Kultur, Seestraße 1', 105, 280, 7.5 * PT, SANS, {
    align: 'center',
  });
  return b.done({
    id: 'notice',
    title: 'Notice: dense text, ruled price tables, big blue logo',
    widthMm: 210,
    heightMm: 297,
    paper: '#fbfbf8',
    format: 'A4',
  });
}

/**
 * A ruled rating questionnaire: one item per row, the rows separated by
 * thin black rules that run nearly the whole width of the sheet, four
 * answer circles per row, a title close to the top edge and a closing line
 * close to the bottom one. Ruled forms trip page detection twice over: the
 * long rules look like page edges (a strip of rows was cropped), and a scan
 * of one fills the whole image, leaving no page edge to find at all.
 */
function questionnaire(): DocSpec {
  const b = new Builder();
  const s = 9 * PT;
  b.text('Weekly Habits Questionnaire', 105, 9, 12 * PT, SANS, {
    weight: 'bold',
    align: 'center',
  });
  b.text('Mark one circle per statement.', 105, 15, s, SANS, { align: 'center' });
  const labels = ['never', 'rarely', 'often', 'always'];
  const cols = [158, 168, 178, 188];
  labels.forEach((label, i) =>
    b.text(label, cols[i] + 1.5, 36, 7 * PT, SANS, { rotate: -Math.PI / 2, ocr: false }),
  );
  const items = [
    'I go for a walk before breakfast.',
    'I read a printed newspaper or magazine.',
    'I cook dinner from fresh ingredients.',
    'I forget where I left my keys.',
    'I water the plants on the balcony.',
    'I call a friend or relative on the phone.',
    'I take the stairs instead of the lift.',
    'I write a shopping list before going out.',
    'I listen to the radio while working.',
    'I tidy my desk at the end of the day.',
    'I ride a bicycle to the station.',
    'I bake bread or cakes at home.',
    'I check the weather forecast twice a day.',
    'I sort the recycling into separate bins.',
    'I fall asleep before eleven at night.',
    'I drink a glass of water after waking up.',
    'I visit the public library in town.',
    'I repair small things around the house.',
    'I play a board game with the family.',
    'I note my expenses in a little book.',
    'I spend an evening without any screens.',
    'I learn a few words of a new language.',
  ];
  const top = 42;
  const row = 10.6;
  b.line(6, top, 204, top, 0.35, '#111');
  items.forEach((item, i) => {
    const y = top + i * row;
    b.text(`${i + 1}.`, 14, y + 6.4, s, SANS);
    b.text(item, 22, y + 6.4, s, SANS);
    b.draw((g) => {
      g.strokeStyle = '#222';
      g.lineWidth = 0.25;
      for (const x of cols) {
        g.beginPath();
        g.arc(x, y + 5.2, 1.6, 0, Math.PI * 2);
        g.stroke();
      }
    });
    b.line(6, y + row, 204, y + row, 0.35, '#111');
  });
  b.text('Please check that every statement has an answer.', 105, 289, s, SANS, {
    align: 'center',
  });
  return b.done({
    id: 'questionnaire',
    title: 'Ruled questionnaire: rules across the page, text near the edges',
    widthMm: 210,
    heightMm: 297,
    paper: '#fcfcfa',
    format: 'A4',
  });
}

export const DOCUMENTS: Record<string, () => DocSpec> = {
  letter_a4: () => letter('letter_a4', 'Plain typed letter (A4)'),
  invoice: () => invoice(),
  receipt,
  contract,
  handwritten,
  form,
  brochure,
  idcard: idCard,
  us_letter: usLetter,
  landscape,
  two_column: twoColumn,
  german,
  paper_yellow: () => colouredPaper('paper_yellow', 'Pastel yellow paper, black text', '#fff2a6'),
  paper_pink: () => colouredPaper('paper_pink', 'Pastel pink paper, black text', '#ffd3df'),
  paper_blue: () => colouredPaper('paper_blue', 'Light blue paper, black text', '#d2e6f8'),
  flyer_blue: () =>
    flyer(
      'flyer_blue',
      'Mid-blue flyer: white text, light panel with black text',
      '#2a5db0',
      '#f5f0d8',
    ),
  flyer_green: () =>
    flyer(
      'flyer_green',
      'Dark green flyer: white text, light green panel with black text',
      '#1f5e3b',
      '#b9e4c9',
    ),
  gradient_vertical: () =>
    gradientPage(
      'gradient_vertical',
      'Full-page gradient, white to mid blue (top to bottom)',
      '#ffffff',
      '#6fa5d9',
      false,
    ),
  gradient_diagonal: () =>
    gradientPage(
      'gradient_diagonal',
      'Full-page gradient, pale to mid rose (diagonal)',
      '#fff8f0',
      '#d9738f',
      true,
    ),
  bands,
  photos,
  coloured_text: colouredText,
  notice,
  questionnaire,
  faded: () =>
    letter('faded', 'Very low contrast, faded print', { color: '#b9b6ae', paper: '#f4f1e8' }),
};

/** Ground-truth text in reading order. */
export function truthText(doc: DocSpec): string {
  return doc.ops
    .filter((o): o is TextOp => o.kind === 'text' && o.ocr !== false)
    .map((o) => o.text)
    .join('\n');
}

/**
 * Render the page at `pxPerMm`. `mode` 'full' draws everything; 'mask' draws
 * only mask text, in black, on white.
 */
export function renderDoc(
  doc: DocSpec,
  pxPerMm: number,
  mode: 'full' | 'mask' | 'reversed' = 'full',
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(doc.widthMm * pxPerMm);
  c.height = Math.round(doc.heightMm * pxPerMm);
  const g = c.getContext('2d')!;
  g.fillStyle = mode === 'full' ? doc.paper : '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const sx = c.width / doc.widthMm;
  const sy = c.height / doc.heightMm;
  for (const op of doc.ops) {
    if (op.kind === 'draw') {
      if (mode !== 'full') continue;
      g.save();
      g.scale(sx, sy);
      op.draw(g);
      g.restore();
      continue;
    }
    if (mode === 'mask' && (op.mask === false || op.reversed)) continue;
    if (mode === 'reversed' && !op.reversed) continue;
    g.save();
    g.fillStyle = mode === 'full' ? (op.color ?? '#141414') : '#000';
    g.translate(op.x * sx, op.y * sy);
    if (op.rotate) g.rotate(op.rotate);
    g.font = fontOf(op, sy);
    g.textAlign = op.align ?? 'left';
    if (op.hand === undefined) {
      g.fillText(op.text, 0, 0);
    } else {
      // Handwriting: glyph by glyph with jittered size, slant, baseline and spacing.
      const r = rng(op.hand);
      let x = 0;
      for (const ch of op.text) {
        const scale = 0.9 + r() * 0.25;
        g.save();
        g.translate(
          x,
          (r() - 0.5) * op.size * 0.12 * sy +
            Math.sin(x / (op.size * sy * 3)) * op.size * 0.08 * sy,
        );
        g.rotate((r() - 0.5) * 0.12);
        g.scale(scale, scale);
        g.fillText(ch, 0, 0);
        g.restore();
        x += g.measureText(ch).width * scale * (0.92 + r() * 0.12);
      }
    }
    g.restore();
  }
  return c;
}
