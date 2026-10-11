"""Generates the bundled sample PDF (also the e2e fixture): chapters, outline, a landscape plate."""
import sys

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, Frame, NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Spacer)

INK = HexColor('#1c1b19')
MUTED = HexColor('#6b675f')
ACCENT = HexColor('#2b4c7e')

CHAPTERS = [
    ('The Page', 'A page is a field of attention. Its margins are not empty space but the frame that lets '
     'the eye rest; its measure decides how far the eye must travel before it returns.'),
    ('The Line', 'Good lines are neither too long nor too short. Between forty-five and seventy-five '
     'characters, the reader keeps their place without effort and the rhythm of the prose survives.'),
    ('The Margin', 'Margins hold the thumb, the pencil and the pause. A generous margin is an invitation '
     'to slow down; a cramped one asks the reader to hurry.'),
    ('The Return', 'Every reader leaves and every reader returns. A book remembers where it was opened; '
     'a good reading tool should remember just as faithfully.'),
    ('The Quire', 'A quire is a gathering of folded sheets, the unit from which books are bound. '
     'It is the smallest whole thing a book is made of.'),
]

FILLER = ('Reading is a negotiation between the eye and the page. The typeface sets the voice, the '
          'leading sets the breath, and the paper sets the light. When all three agree, the reader '
          'forgets the object and remembers only the text. That forgetting is the whole point of the '
          'craft: an interface for reading succeeds by disappearing. ')

body = ParagraphStyle('body', fontName='Times-Roman', fontSize=11.5, leading=17, textColor=INK,
                      spaceAfter=10, firstLineIndent=14)
lead = ParagraphStyle('lead', parent=body, fontName='Times-Italic', fontSize=13.5, leading=20,
                      firstLineIndent=0, textColor=MUTED, spaceAfter=18)
h1 = ParagraphStyle('h1', fontName='Times-Bold', fontSize=30, leading=36, textColor=INK, spaceAfter=8)
kicker = ParagraphStyle('kicker', fontName='Helvetica', fontSize=8.5, leading=12, textColor=ACCENT,
                        spaceAfter=6)
title = ParagraphStyle('title', parent=h1, fontSize=46, leading=52, spaceBefore=180)
plate = ParagraphStyle('plate', parent=h1, fontSize=40, leading=46, textColor=ACCENT)


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
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(doc.pagesize[0] / 2, 28, str(doc.page))
    canvas.restoreState()


def main(out):
    doc = Doc(out, pagesize=A4, title='The Elements of Reading', author='Quire')
    w, h = A4
    doc.addPageTemplates([
        PageTemplate('portrait', [Frame(72, 64, w - 144, h - 136)], onPage=footer, pagesize=A4),
        PageTemplate('landscape', [Frame(72, 64, h - 144, w - 136)], onPage=footer,
                     pagesize=landscape(A4)),
    ])
    story = [Paragraph('THE ELEMENTS OF', kicker), Paragraph('The Elements<br/>of Reading', title),
             Paragraph('Five short chapters on pages, lines and returning.', lead), PageBreak()]
    for i, (name, intro) in enumerate(CHAPTERS, 1):
        story += [Paragraph(f'CHAPTER {i}', kicker), heading(name, f'ch{i}'), Paragraph(intro, lead)]
        for s in range(1, 4):
            story += [heading(f'{name} — section {s}', f'ch{i}s{s}', style=ParagraphStyle(
                'h2', fontName='Times-Bold', fontSize=15, leading=20, spaceBefore=14, spaceAfter=6,
                textColor=INK), level=1)]
            story += [Paragraph(FILLER * 2, body) for _ in range(5)]
        if i == 3:
            story += [NextPageTemplate('landscape'), PageBreak(),
                      heading('Plate I — The Measure', 'plate', style=plate),
                      Paragraph('A landscape page, to prove the reader respects each page’s own shape.',
                                lead), NextPageTemplate('portrait')]
        story.append(PageBreak())
    doc.build(story)


if __name__ == '__main__':
    main(sys.argv[1])
