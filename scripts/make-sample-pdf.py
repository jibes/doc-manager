"""Generates the bundled sample PDF (also the e2e fixture): a short guide to Tessel with an
outline, a landscape page and a shortcuts table."""
import sys

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Spacer, Table, TableStyle)

# Brand type (Inter) for text; DejaVu for the shortcut keys, which need ⌘ ⇧ and arrows.
FONTS = 'node_modules/@expo-google-fonts/inter'
pdfmetrics.registerFont(TTFont('Inter', f'{FONTS}/400Regular/Inter_400Regular.ttf'))
pdfmetrics.registerFont(TTFont('Inter-SemiBold', f'{FONTS}/600SemiBold/Inter_600SemiBold.ttf'))
pdfmetrics.registerFont(TTFont('Keys', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))

INK = HexColor('#1b1a17')
MUTED = HexColor('#6b675f')
ACCENT = HexColor('#2f4f86')
RULE = HexColor('#ddd8cc')

CHAPTERS = [
    ('Opening files', 'Every PDF you open lands in Recent, newest first. Nothing leaves your device.', [
        ('Ways to open', [
            'Use Open file on the home screen, drop a file anywhere on the window, or choose Tessel from '
            'your system’s Open with menu once it is installed. Opening the same file twice simply takes '
            'you back to it. EPUB books open too, and go straight onto your reading list.',
            'In Chrome and Edge, Tessel opens the file where it is saved, so form entries, highlights and '
            'notes are saved back into it. Other browsers keep a copy in Tessel instead.',
        ]),
        ('Removing a file', [
            'Removing a document from Tessel forgets it: its copy (if it has one), its cover and its saved '
            'position. The original file is never deleted. On a desktop, hover a row and use the bin; on a phone, press '
            'and hold the row.',
        ]),
    ]),
    ('Finding your way', 'Long documents stay manageable: you always know where you are and how to get anywhere.', [
        ('The scrubber', [
            'The thin line along the bottom edge is the scrubber. Drag it to move through the whole document; '
            'a preview shows the page and the chapter you are about to land on. Short ticks mark chapters, '
            'accent ticks mark your bookmarks.',
        ]),
        ('Contents, pages and bookmarks', [
            'The list button opens Navigate. Contents shows the document’s own outline, Pages shows every '
            'page as a thumbnail, and Bookmarks lists the pages you marked with the ribbon button.',
            'Tap the page number at the bottom to type a page and jump straight to it. Links work too: '
            'this one goes to <a href="#ch5" color="#2f4f86"><u>Keyboard shortcuts</u></a>.',
        ]),
        ('Search', [
            'Search looks through the full text of the document. Every match is highlighted on the page and '
            'the current one is outlined. Close the panel and a small find bar stays at the top so you can '
            'step through matches while you look at the page. Clear it to remove the highlights.',
        ]),
    ]),
    ('The reading list', 'Most files are for checking. Some are for reading. Tessel treats them differently.', [
        ('Adding a document', [
            'Use the book button in the viewer, or next to any file in Recent, to add it to your reading list. '
            'Reading-list documents appear at the top of the home screen with their progress, and the one '
            'you read last waits in a Continue card.',
        ]),
        ('Reading behaviour', [
            'While you read a document from your reading list, the toolbars step aside as you move forward '
            'and come back when you scroll up or tap the page. The page indicator also shows how far you '
            'are. Ordinary documents keep their toolbars visible at all times.',
            'Reach the last page and the document moves to Finished. Tessel remembers where you left off in '
            'every file, on the list or not.',
        ]),
    ]),
    ('Making it comfortable', 'Pages should look right in a bright office and in a dark room.', [
        ('Appearance', [
            'The Aa button sets the theme: Light, Sepia, Dark or Black, or Auto to follow your system. Fit '
            'width fills the screen with the page; Fit page shows each page whole. Zoom with the buttons, '
            'with a pinch, or with Ctrl and the scroll wheel.',
        ]),
    ]),
]

SHORTCUTS = [
    ('Search', '⌘F / Ctrl F'), ('Next / previous match', '⌘G / ⇧⌘G or F3'), ('Contents', 'T'),
    ('Bookmark page', 'B'), ('Next / previous page', '→  ←'), ('Scroll', '↑ ↓  J K  Space'),
    ('First / last page', 'Home  End'), ('Zoom in / out / reset', '⌘+  ⌘−  ⌘0'), ('Close panel, go back', 'Esc'),
]

body = ParagraphStyle('body', fontName='Inter', fontSize=10.5, leading=16, textColor=INK, spaceAfter=9)
lead = ParagraphStyle('lead', parent=body, fontSize=13, leading=19, textColor=MUTED, spaceAfter=16)
h1 = ParagraphStyle('h1', fontName='Inter-SemiBold', fontSize=26, leading=31, textColor=INK, spaceAfter=8)
h2 = ParagraphStyle('h2', fontName='Inter-SemiBold', fontSize=13, leading=18, textColor=INK, spaceBefore=12, spaceAfter=5)
kicker = ParagraphStyle('kicker', fontName='Inter-SemiBold', fontSize=8, leading=12, textColor=ACCENT, spaceAfter=6)
title = ParagraphStyle('title', parent=h1, fontSize=40, leading=46, spaceBefore=200)
plate = ParagraphStyle('plate', parent=h1, fontSize=34, leading=40, textColor=ACCENT)


class Doc(BaseDocTemplate):
    def afterFlowable(self, f):
        key = getattr(f, '_bookmark', None)
        if key:
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(f._label, key, level=f._level)


def heading(text, key, style=h1, level=0):
    p = Paragraph(text, style)
    p._bookmark, p._label, p._level = key, text, level
    return p


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Inter', 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(doc.pagesize[0] / 2, 28, str(doc.page))
    canvas.restoreState()


def main(out, password=None):
    # --password produces the encrypted e2e fixture.
    encrypt = None
    if password:
        from reportlab.lib import pdfencrypt
        encrypt = pdfencrypt.StandardEncryption(password, canPrint=1, canCopy=1)
    doc = Doc(out, pagesize=A4, title='Welcome to Tessel', author='Tessel', encrypt=encrypt)
    w, h = A4
    doc.addPageTemplates([
        PageTemplate('portrait', [Frame(72, 64, w - 144, h - 136)], onPage=footer, pagesize=A4),
        PageTemplate('landscape', [Frame(72, 64, h - 144, w - 136)], onPage=footer, pagesize=landscape(A4)),
    ])
    story = [Paragraph('A SHORT GUIDE', kicker), Paragraph('Welcome<br/>to Tessel', title),
             Paragraph('Every document, in its place. Five short chapters on opening, finding, reading '
                       'and seeing your files clearly.', lead), PageBreak()]
    for i, (name, intro, sections) in enumerate(CHAPTERS, 1):
        story += [Paragraph(f'CHAPTER {i}', kicker), heading(name, f'ch{i}'), Paragraph(intro, lead)]
        for s, (sec, paras) in enumerate(sections, 1):
            story.append(heading(sec, f'ch{i}s{s}', style=h2, level=1))
            story += [Paragraph(t, body) for t in paras]
        if i == 2:
            story += [NextPageTemplate('landscape'), PageBreak(),
                      heading('Every page keeps its shape', 'plate', style=plate),
                      Paragraph('This page is landscape. Tessel shows each page in its own proportions, '
                                'so wide tables and slides are never squeezed.', lead),
                      NextPageTemplate('portrait')]
        story.append(PageBreak())
    story += [Paragraph('CHAPTER 5', kicker), heading('Keyboard shortcuts', 'ch5'),
              Paragraph('On a computer, everything has a key.', lead)]
    table = Table([[a, b] for a, b in SHORTCUTS], colWidths=[220, 200])
    table.setStyle(TableStyle([
        ('FONT', (0, 0), (0, -1), 'Inter', 10.5), ('FONT', (1, 0), (1, -1), 'Keys', 10.5),
        ('TEXTCOLOR', (0, 0), (-1, -1), INK),
        ('TEXTCOLOR', (1, 0), (1, -1), MUTED), ('LINEBELOW', (0, 0), (-1, -2), 0.5, RULE),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ]))
    story += [table, Spacer(1, 24),
              Paragraph('Tessel is free software under the GNU AGPL. No ads, no account, no tracking. Source: '
                        '<a href="https://github.com/jibes/doc-reader" color="#2f4f86"><u>github.com/jibes/doc-reader</u></a>',
                        lead)]
    doc.build(story)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == '--password' else None)
