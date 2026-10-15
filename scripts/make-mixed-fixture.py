"""e2e/fixtures/mixed.pdf: a typed page, then a scanned one (no text): Make searchable is offered for it all the same."""
from pypdf import PdfReader, PdfWriter

out = PdfWriter()
out.add_page(PdfReader('e2e/fixtures/columns.pdf').pages[0])
out.add_page(PdfReader('e2e/fixtures/scan.pdf').pages[0])
out.add_metadata({'/Title': 'Mixed pages'})
with open('e2e/fixtures/mixed.pdf', 'wb') as f:
    out.write(f)
