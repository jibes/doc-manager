"""E2E fixtures for text view layout: a two-column paper with a chart, a photo and a table
(e2e/fixtures/columns.pdf), and an image-only "scan" for OCR (e2e/fixtures/scan.pdf)."""
import io

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (BaseDocTemplate, Frame, FrameBreak, Image as RLImage, NextPageTemplate,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

FONTS = 'node_modules/@expo-google-fonts/inter'
pdfmetrics.registerFont(TTFont('Inter', f'{FONTS}/400Regular/Inter_400Regular.ttf'))
pdfmetrics.registerFont(TTFont('Inter-SemiBold', f'{FONTS}/600SemiBold/Inter_600SemiBold.ttf'))

W, H = A4
M = 54
GAP = 20
COL = (W - 2 * M - GAP) / 2
INK = HexColor('#1b1a17')

body = ParagraphStyle('body', fontName='Inter', fontSize=9.5, leading=13, textColor=INK, spaceAfter=7)
title = ParagraphStyle('title', fontName='Inter-SemiBold', fontSize=22, leading=27, textColor=INK, spaceAfter=6)
lede = ParagraphStyle('lede', fontName='Inter', fontSize=11, leading=15, textColor=INK)
h2 = ParagraphStyle('h2', fontName='Inter-SemiBold', fontSize=12.5, leading=16, textColor=INK, spaceBefore=6, spaceAfter=5)
caption = ParagraphStyle('caption', fontName='Inter', fontSize=8, leading=10.5, textColor=HexColor('#55524b'), spaceAfter=9)
cell = ParagraphStyle('cell', fontName='Inter', fontSize=8.5, leading=11)

SENTENCES = [
    'Field notes accumulate faster than anyone can file them.',
    'A good index turns that heap into something one can walk through.',
    'Each entry names a place, a date and the person who wrote it down.',
    'Cross references tie the entries together where the paper trail forks.',
    'Nothing here is new, but the order of things changes how they read.',
    'Readers who return after a week want to land exactly where they stopped.',
]


def prose(n, seed):
    return ' '.join(SENTENCES[(seed + i) % len(SENTENCES)] for i in range(n))


def chart():
    d = Drawing(COL, 120)
    c = VerticalBarChart()
    c.x, c.y, c.width, c.height = 24, 18, COL - 34, 92
    c.data = [[12, 18, 9, 22, 15], [8, 11, 14, 10, 19]]
    c.categoryAxis.categoryNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    c.categoryAxis.labels.fontName = c.valueAxis.labels.fontName = 'Inter'
    c.categoryAxis.labels.fontSize = c.valueAxis.labels.fontSize = 6.5
    c.bars[0].fillColor = HexColor('#2f4f86')
    c.bars[1].fillColor = HexColor('#c9a227')
    d.add(c)
    return d


def photo():
    img = Image.new('RGB', (600, 380))
    px = img.load()
    for y in range(380):
        for x in range(600):
            px[x, y] = (40 + x // 5, 70 + y // 4, 120 + (x + y) // 12)
    ImageDraw.Draw(img).ellipse((360, 60, 520, 220), fill=(240, 210, 120))
    buf = io.BytesIO()
    img.filter(ImageFilter.GaussianBlur(2)).save(buf, 'PNG')
    buf.seek(0)
    return RLImage(buf, width=COL, height=COL * 380 / 600)


def furniture(c, doc):
    c.saveState()
    c.setFont('Inter', 7.5)
    c.setFillColor(HexColor('#8a867c'))
    c.drawString(M, H - 34, 'Journal of Orderly Notes · Volume 3')
    c.drawRightString(W - M, 30, str(doc.page))
    c.restoreState()


def columns_pdf(path):
    doc = BaseDocTemplate(path, pagesize=A4, title='Orderly Notes', author='Tessel')
    top = H - M - 110
    head = Frame(M, top, W - 2 * M, 110, id='head', leftPadding=0, rightPadding=0)
    first = [head] + [Frame(M + i * (COL + GAP), M, COL, top - M - 8, id=f'c{i}', leftPadding=0, rightPadding=0) for i in range(2)]
    rest = [Frame(M + i * (COL + GAP), M, COL, H - 2 * M, id=f'r{i}', leftPadding=0, rightPadding=0) for i in range(2)]
    doc.addPageTemplates([PageTemplate('first', first, onPage=furniture), PageTemplate('rest', rest, onPage=furniture)])

    table = Table(
        [['Site', 'Visits', 'Year']] + [[s, str(v), str(y)] for s, v, y in [('Harbour', 12, 2019), ('Quarry', 7, 2021), ('Orchard', 31, 2024), ('Mill', 4, 2025)]],
        colWidths=[COL * 0.45, COL * 0.25, COL * 0.3],
    )
    table.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, -1), 'Inter', 8.5),
        ('FONT', (0, 0), (-1, 0), 'Inter-SemiBold', 8.5),
        ('LINEBELOW', (0, 0), (-1, 0), 0.6, INK),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))

    story = [
        Paragraph('Orderly Notes', title),
        Paragraph('How an index makes a pile of field notes readable, with one chart, one photo and one table.', lede),
        NextPageTemplate('rest'),
        FrameBreak(),
        Paragraph('Why order matters', h2),
        Paragraph(prose(9, 0), body),
        Paragraph(prose(8, 2), body),
        chart(),
        Paragraph('Figure 1: Notes filed per weekday, two seasons.', caption),
        Paragraph(prose(10, 1), body),
        Paragraph('Keeping place', h2),
        Paragraph(prose(12, 3), body),
        Paragraph('The column ends in the middle of this paragraph, which carries on in the next column ' + prose(14, 4), body),
        photo(),
        Paragraph('Figure 2: The harbour at dusk, where most notes begin.', caption),
        Paragraph(prose(9, 5), body),
        Paragraph('Table 1: Visits per site.', caption),
        table,
        Spacer(1, 10),
        Paragraph('After the table the text continues as usual. ' + prose(16, 2), body),
        Paragraph('The last paragraph closes the paper and says goodbye.', body),
    ]
    doc.build(story)


def scan_pdf(path):
    """Two pages of text rendered to 200 dpi images: no text layer, like a scanner's output."""
    dpi = 200
    font = ImageFont.truetype(f'{FONTS}/400Regular/Inter_400Regular.ttf', int(11 * dpi / 72))
    big = ImageFont.truetype(f'{FONTS}/600SemiBold/Inter_600SemiBold.ttf', int(20 * dpi / 72))
    pages = [
        ('Scanned Letter', ['Tessel recognizes scanned pages on this device.', 'Nothing is uploaded anywhere at all.', '', 'The quick brown fox jumps over the lazy dog.']),
        ('Second Page', ['Recognition continues page by page while you read.', 'Results are kept so it never runs twice.']),
    ]
    c = canvas.Canvas(path, pagesize=A4)
    for heading, lines in pages:
        img = Image.new('L', (int(W * dpi / 72), int(H * dpi / 72)), 255)
        d = ImageDraw.Draw(img)
        y = int(90 * dpi / 72)
        d.text((int(72 * dpi / 72), y), heading, font=big, fill=20)
        y += int(44 * dpi / 72)
        for line in lines:
            d.text((int(72 * dpi / 72), y), line, font=font, fill=25)
            y += int(17 * dpi / 72)
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        buf.seek(0)
        c.drawImage(ImageReader(buf), 0, 0, W, H)
        c.showPage()
    c.save()


if __name__ == '__main__':
    columns_pdf('e2e/fixtures/columns.pdf')
    scan_pdf('e2e/fixtures/scan.pdf')
