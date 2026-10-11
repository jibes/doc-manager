"""E2E fixture for form filling: e2e/fixtures/form.pdf with a text field, a multi-line field,
a checkbox, a radio group and a dropdown (AcroForm, with appearance streams)."""
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
INK = HexColor('#1b1a17')


def build(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle('Visit request')
    c.setFont('Helvetica-Bold', 20)
    c.drawString(60, H - 80, 'Visit request')
    c.setFont('Helvetica', 11)
    form = c.acroForm
    y = H - 140

    c.drawString(60, y, 'Full name')
    form.textfield(name='name', x=180, y=y - 6, width=300, height=22, borderColor=INK, fillColor=None, fontSize=11)
    y -= 50
    c.drawString(60, y, 'Notes')
    form.textfield(name='notes', x=180, y=y - 50, width=300, height=66, borderColor=INK, fillColor=None, fontSize=10,
                   fieldFlags='multiline')
    y -= 100
    c.drawString(60, y, 'Room size')
    for i, v in enumerate(['Small', 'Medium', 'Large']):
        form.radio(name='size', value=v, x=180 + i * 90, y=y - 4, size=16, buttonStyle='circle', borderColor=INK,
                   selected=(v == 'Medium'))
        c.drawString(200 + i * 90, y, v)
    y -= 50
    c.drawString(60, y, 'Site')
    form.choice(name='site', options=['Harbour', 'Quarry', 'Orchard', 'Mill'], value='Harbour', x=180, y=y - 6,
                width=200, height=22, borderColor=INK, fillColor=None, fontSize=11)
    y -= 50
    form.checkbox(name='agree', x=180, y=y - 4, size=16, buttonStyle='check', borderColor=INK, checked=False)
    c.drawString(204, y, 'I agree to keep the notes in order')
    c.showPage()
    c.save()


if __name__ == '__main__':
    build('e2e/fixtures/form.pdf')
