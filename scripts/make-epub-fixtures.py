"""E2E/unit fixtures for books: e2e/fixtures/book.epub (EPUB 3: nav, cover, footnotes, figure, list,
table, scene break, code) and e2e/fixtures/book2.epub (EPUB 2: NCX table of contents, <meta name="cover">)."""
import io
import zipfile

from PIL import Image, ImageDraw

LOREM = ('The harbour wakes before the town does. Gulls work the tideline, the ferry coughs into life, '
         'and somewhere a kettle is already on. ')


def png(w, h, color, label):
    img = Image.new('RGB', (w, h), color)
    d = ImageDraw.Draw(img)
    d.rectangle((20, 20, w - 20, h - 20), outline=(255, 255, 255), width=6)
    d.text((40, h // 2), label, fill=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()


def xhtml(title, body):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>{title}</title><link rel="stylesheet" href="../style.css"/></head>
<body>{body}</body></html>'''


def write(path, files):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        for name, data in files.items():
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)


CONTAINER = '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>'''


def book3():
    ch1 = xhtml('The Harbour', f'''
<section epub:type="chapter">
  <h1>Chapter One<br/>The Harbour</h1>
  <p>It began, as most things here do, with <em>the tide</em> and a <strong>very</strong> early ferry.<a epub:type="noteref" href="notes.xhtml#n1" id="r1">1</a></p>
  <p>{LOREM * 3}</p>
  <blockquote><p>Order is a kindness you do for your future self.</p></blockquote>
  <ol><li>Check the moorings.</li><li>Count the crates.</li><li>Write it down.</li></ol>
  <hr/>
  <p>Later, the light changed.&nbsp;See <a href="https://example.org/harbour">the harbour office</a> for times.</p>
  <figure><img src="../images/map.png" alt="Map of the harbour"/><figcaption>Figure 1. The harbour at low tide.</figcaption></figure>
  <table><tr><th>Boat</th><th>Crates</th></tr><tr><td>Heron</td><td>12</td></tr><tr><td>Osprey</td><td>7</td></tr></table>
  <pre>ledger  12
crates   7</pre>
</section>''')
    ch2 = xhtml('The Quarry', '<h2 id="quarry">Chapter Two</h2>' + ''.join(f'<p>{i + 1}. {LOREM * 4}</p>' for i in range(24))
                + '<h3 id="dusk">At dusk</h3><p>The last paragraph of the second chapter ends here.</p>')
    notes = xhtml('Notes', '<h2>Notes</h2><aside epub:type="footnote" id="n1"><p>1. The first ferry leaves at 05:40.</p></aside>')
    nav = '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><h1>Contents</h1><ol>
  <li><a href="text/ch1.xhtml">The Harbour</a></li>
  <li><a href="text/ch2.xhtml#quarry">The Quarry</a><ol><li><a href="text/ch2.xhtml#dusk">At dusk</a></li></ol></li>
  <li><a href="text/notes.xhtml">Notes</a></li>
</ol></nav></body></html>'''
    opf = '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:tessel-fixture-1</dc:identifier>
    <dc:title>Harbour Notes</dc:title><dc:creator>Ada Quay</dc:creator><dc:language>en</dc:language>
    <dc:date>2019-04-02T08:00:00Z</dc:date><dc:subject>Harbours</dc:subject><dc:subject> Travel </dc:subject><dc:subject>Harbours</dc:subject>
    <meta property="dcterms:modified">2026-10-12T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="map" href="images/map.png" media-type="image/png"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="nav" linear="no"/><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="notes"/></spine>
</package>'''
    write('e2e/fixtures/book.epub', {
        'META-INF/container.xml': CONTAINER,
        'OEBPS/content.opf': opf,
        'OEBPS/nav.xhtml': nav,
        'OEBPS/style.css': 'body { font-family: serif; }',
        'OEBPS/images/cover.png': png(600, 900, (47, 79, 134), 'Harbour Notes'),
        'OEBPS/images/map.png': png(800, 450, (60, 120, 90), 'Map'),
        'OEBPS/text/ch1.xhtml': ch1,
        'OEBPS/text/ch2.xhtml': ch2,
        'OEBPS/text/notes.xhtml': notes,
    })


def book2():
    chapters = [('c1.html', 'Arrival', 6), ('c2.html', 'Departure', 6)]
    opf = '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Two Chapters</dc:title><dc:creator opf:role="aut">B. Older</dc:creator><dc:date opf:event="publication">2003</dc:date><dc:identifier id="id">tessel-2</dc:identifier>
    <meta name="cover" content="img-cover"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="img-cover" href="cover.jpg" media-type="image/jpeg"/>
    ''' + ''.join(f'<item id="c{i}" href="{f}" media-type="application/xhtml+xml"/>' for i, (f, _, _) in enumerate(chapters)) + '''
  </manifest>
  <spine toc="ncx">''' + ''.join(f'<itemref idref="c{i}"/>' for i in range(len(chapters))) + '''</spine>
</package>'''
    ncx = '''<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>''' + ''.join(
        f'<navPoint id="p{i}" playOrder="{i + 1}"><navLabel><text>{t}</text></navLabel><content src="{f}"/></navPoint>'
        for i, (f, t, _) in enumerate(chapters)) + '</navMap></ncx>'
    buf = io.BytesIO()
    Image.new('RGB', (500, 750), (140, 60, 40)).save(buf, 'JPEG')
    files = {'META-INF/container.xml': CONTAINER.replace('OEBPS/', ''), 'content.opf': opf, 'toc.ncx': ncx, 'cover.jpg': buf.getvalue()}
    for f, t, n in chapters:
        files[f] = f'<html><head><title>{t}</title></head><body><h1>{t}</h1>' + ''.join(f'<p>{LOREM * 2}</p>' for _ in range(n)) + '</body></html>'
    write('e2e/fixtures/book2.epub', files)


if __name__ == '__main__':
    book3()
    book2()
