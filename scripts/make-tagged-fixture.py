"""Builds e2e/fixtures/tagged.pdf: a tagged PDF (via LibreOffice) with headings, a list, and a
running header/footer that must not appear in the text view."""
import os
import subprocess
import sys
import tempfile

PARA = ('A tagged document carries its own structure: headings, paragraphs and lists are marked as such, '
        'so a reader can reflow it without guessing. Running headers and footers are marked as artifacts '
        'and should never show up between paragraphs. ')

def body():
    out = []
    for i in range(1, 4):
        out.append(f'<text:h text:style-name="Heading_20_1" text:outline-level="1">Part {i}</text:h>')
        for j in range(1, 3):
            out.append(f'<text:h text:style-name="Heading_20_2" text:outline-level="2">Section {i}.{j}</text:h>')
            out += [f'<text:p text:style-name="Text_20_body">{PARA * 3}</text:p>' for _ in range(3)]
        out.append('<text:list><text:list-item><text:p>First point</text:p></text:list-item>'
                   '<text:list-item><text:p>Second point</text:p></text:list-item></text:list>')
    return '\n'.join(out)

FODT = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1">
   <style:header><text:p>Tagged fixture — running header</text:p></style:header>
   <style:footer><text:p>Page <text:page-number text:select-page="current"/></text:p></style:footer>
  </style:master-page>
 </office:master-styles>
 <office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin="2cm"/></style:page-layout></office:automatic-styles>
 <office:body><office:text>
  <text:h text:style-name="Title" text:outline-level="1">Tagged Fixture</text:h>
  {body()}
 </office:text></office:body>
</office:document>'''

def main(out):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'tagged.fodt')
        open(src, 'w').write(FODT)
        fmt = 'pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"}}'
        subprocess.run(['soffice', '--headless', '--convert-to', fmt, '--outdir', tmp, src], check=True, capture_output=True)
        os.replace(os.path.join(tmp, 'tagged.pdf'), out)

if __name__ == '__main__':
    main(sys.argv[1])
