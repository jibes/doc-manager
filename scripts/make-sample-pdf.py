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
    ('Adding documents', 'Everything comes in one way: from the camera or from your files, into the Tessel folder.', [
        ('Camera or files', [
            'Press + and choose Camera to scan paper, or Files to add PDFs you already have. Either way the '
            'document becomes a file in the Tessel folder (in its Inbox, once you sync a folder), and pages '
            'without text get theirs read on your device, so every document can be searched.',
            'With AI reading set up in Settings, the same switch on each add lets the model read the text '
            'instead. Pages that already have text are left as they are.',
        ]),
        ('Opened from elsewhere', [
            'A file opened with Tessel from another app, or with Open file, is only viewed. Keep it, or save a '
            'note or a filled form, and it is added the same way. Removing a document deletes its file (in the '
            'Tessel folder it goes to the trash first, for 30 days).',
        ]),
    ]),
    ('Finding your way', 'Long documents stay manageable: you always know where you are and how to get anywhere.', [
        ('The scrubber', [
            'The thin line along the bottom edge is the scrubber. Drag it to move through the whole document; '
            'a preview shows the page and the chapter you are about to land on. Short ticks mark chapters, '
            'accent ticks mark pages with notes.',
        ]),
        ('Contents, pages and notes', [
            'The list button opens Navigate. Contents shows the document’s own outline and Pages shows every '
            'page as a thumbnail. A note on a page (the note button, or B) is saved in the file itself.',
            'Tap the page number at the bottom to type a page and jump straight to it. Links work too: '
            'this one goes to <a href="#ch5" color="#2f4f86"><u>Keyboard shortcuts</u></a>.',
        ]),
        ('Search', [
            'Search looks through the full text of the document. Every match is highlighted on the page and '
            'the current one is outlined. Close the panel and a small find bar stays at the top so you can '
            'step through matches while you look at the page. Clear it to remove the highlights.',
        ]),
    ]),
    ('Finding documents', 'No folders to file into: one list, searched by what documents say and who sent them.', [
        ('One list', [
            'Documents lists everything in the Tessel folder, last opened first. Search finds words inside '
            'every document; the filter narrows by tag, sender, type and year, and a search or filter can be '
            'saved as a view. Details (title, sender, type, date, tags) are written into the PDF itself.',
        ]),
        ('One folder, and duplicates', [
            'Every document is a file in the Tessel folder: this device’s own, or a folder you choose in Settings '
            '(one that syncs, say). Import a folder there copies the PDFs you already have in, once.',
            'Documents there twice, or older versions of one, are listed under More → Duplicates, with the '
            'space removing the others frees.',
        ]),
    ]),
    ('Making it comfortable', 'Pages should look right in a bright office and in a dark room.', [
        ('Appearance', [
            'The Aa button sets the theme: Light, Dark, or Auto to follow your system. Fit '
            'width fills the screen with the page; Fit page shows each page whole. Zoom with the buttons, '
            'with a pinch, or with Ctrl and the scroll wheel.',
        ]),
    ]),
]

SHORTCUTS = [
    ('Search', '⌘F / Ctrl F'), ('Next / previous match', '⌘G / ⇧⌘G or F3'), ('Contents', 'T'),
    ('Note on this page', 'B'), ('Next / previous page', '→  ←'), ('Scroll', '↑ ↓  J K  Space'),
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
                        '<a href="https://github.com/jibes/doc-manager" color="#2f4f86"><u>github.com/jibes/doc-manager</u></a>',
                        lead)]
    doc.build(story)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == '--password' else None)
