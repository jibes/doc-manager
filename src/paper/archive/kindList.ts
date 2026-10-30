import type { Lang } from '@/core/i18n';
import { nameKey } from './vocabulary';

/**
 * What the details' Type and Tags mean, so the two never overlap: the type is what a document *is* (its form:
 * an invoice, a contract), exactly one, from a fixed list; the tags are what it is *about* (a topic or area of
 * life: health, a car), one to three. Who sent it is the sender; when, the date. Each name has a description,
 * which tells the model (and whoever edits the list) where the line runs.
 */
export type Named = { name: string; about: string };

export type Kinds = {
  /** The types to choose from; the last one is where a document goes that fits none. */
  types: Named[];
  /** Tags to prefer (with onlyTags: the only ones). May be empty: then the tags in use are offered. */
  tags: Named[];
  onlyTags: boolean;
};

const DEFAULT_TYPES: Record<Lang, [string, string][]> = {
  de: [
    ['Rechnung', 'Fordert Geld für eine Ware oder Leistung.'],
    ['Quittung', 'Bestätigt eine schon geleistete Zahlung: Kassenbon, Beleg, Zahlungsbestätigung.'],
    ['Vertrag', 'Vereinbarung mit Rechten und Pflichten, auch ihre Änderung oder Kündigung.'],
    ['Police', 'Versicherungsschein einer Versicherung und seine Nachträge.'],
    ['Kontoauszug', 'Bewegungen und Stand eines Kontos, Depots oder einer Karte.'],
    ['Lohnabrechnung', 'Lohn- oder Gehaltsabrechnung, Lohnsteuerbescheinigung.'],
    ['Bescheid', 'Entscheidung einer Behörde oder Kasse: Steuer-, Renten-, Leistungsbescheid.'],
    ['Mahnung', 'Erinnert an eine offene Zahlung oder mahnt sie an.'],
    ['Angebot', 'Angebot oder Kostenvoranschlag, noch nicht vereinbart.'],
    ['Bestätigung', 'Bestätigt einen Auftrag, Termin, eine Buchung, Anmeldung oder Mitgliedschaft.'],
    ['Befund', 'Arztbericht, Befund, Rezept, Attest oder Krankschreibung.'],
    ['Urkunde', 'Zeugnis, Zertifikat, Ausweis oder amtliche Urkunde.'],
    ['Anleitung', 'Bedienungsanleitung, Garantie- oder Produktinformation.'],
    ['Brief', 'Anderes Schreiben an dich, das keine der Arten oben ist.'],
    ['Sonstiges', 'Passt zu keiner anderen Art.'],
  ],
  en: [
    ['Invoice', 'Asks for money for goods or a service.'],
    ['Receipt', 'Confirms a payment already made: till receipt, voucher, payment confirmation.'],
    ['Contract', 'An agreement with rights and duties, also its change or cancellation.'],
    ['Policy', 'An insurance policy and its amendments.'],
    ['Statement', 'Transactions and balance of an account, a portfolio or a card.'],
    ['Payslip', 'Pay or salary statement, annual tax statement from the employer.'],
    ['Notice', 'A decision of an authority or fund: tax assessment, pension or benefit notice.'],
    ['Reminder', 'Reminds of or demands an open payment.'],
    ['Quote', 'An offer or estimate, not agreed yet.'],
    ['Confirmation', 'Confirms an order, appointment, booking, registration or membership.'],
    ['Medical', 'Doctor’s report, findings, prescription or sick note.'],
    ['Certificate', 'Certificate, diploma, ID or official record.'],
    ['Manual', 'User manual, warranty or product information.'],
    ['Letter', 'Any other letter to you that is none of the types above.'],
    ['Other', 'Fits no other type.'],
  ],
};

/** Areas of life, each a topic of its own: none contains another, none is a type of document or a kind of sender. */
const DEFAULT_TAGS: Record<Lang, [string, string][]> = {
  de: [
    ['Gesundheit', 'Ärzte, Spital, Krankenkasse, Medikamente, Therapien.'],
    ['Versicherung', 'Policen, Prämien und Schadenfälle jeder Versicherung.'],
    ['Steuern', 'Steuererklärung, Steuerbescheide und Belege dafür.'],
    ['Finanzen', 'Bank, Karten, Kredite, Anlagen, Vorsorge.'],
    ['Arbeit', 'Arbeitgeber, Lohn, Arbeitsvertrag, Bewerbungen.'],
    ['Bildung', 'Schule, Studium, Kurse, Zeugnisse und Diplome.'],
    ['Wohnen', 'Miete oder Eigentum, Nebenkosten, Energie, Haushalt.'],
    ['Mobilität', 'Auto, öffentlicher Verkehr, Reisen.'],
    ['Telefon & Internet', 'Mobilabo, Internetanschluss, digitale Abos.'],
    ['Identität', 'Ausweis, Pass, Zivilstand, Wohnsitz und Meldewesen.'],
    ['Familie', 'Ehe, Kinder, Betreuung, Erbschaft.'],
    ['Recht', 'Anwalt, Gericht, Bussen, Streitfälle.'],
  ],
  en: [
    ['Health', 'Doctors, hospital, health insurer, medication, therapy.'],
    ['Insurance', 'Policies, premiums and claims of any insurance.'],
    ['Taxes', 'Tax returns, tax assessments and the receipts for them.'],
    ['Finances', 'Bank, cards, loans, investments, pensions.'],
    ['Work', 'Employer, pay, employment contract, job applications.'],
    ['Education', 'School, studies, courses, certificates and diplomas.'],
    ['Home', 'Rent or ownership, utilities, energy, household.'],
    ['Transport', 'Car, public transport, travel.'],
    ['Phone & Internet', 'Mobile plan, internet connection, digital subscriptions.'],
    ['Identity', 'ID card, passport, civil status, residence registration.'],
    ['Family', 'Marriage, children, childcare, inheritance.'],
    ['Legal', 'Lawyer, court, fines, disputes.'],
  ],
};

export const defaultKinds = (lang: Lang): Kinds => ({
  types: DEFAULT_TYPES[lang].map(([name, about]) => ({ name, about })),
  tags: DEFAULT_TAGS[lang].map(([name, about]) => ({ name, about })),
  onlyTags: false,
});

/** Names once each (by nameKey), trimmed, without empty ones. */
const cleaned = (list: unknown): Named[] => {
  const out: Named[] = [];
  for (const x of Array.isArray(list) ? list : []) {
    const name = typeof (x as Named)?.name === 'string' ? (x as Named).name.trim() : '';
    const about = typeof (x as Named)?.about === 'string' ? (x as Named).about.trim() : '';
    if (name && !out.some((y) => nameKey(y.name) === nameKey(name))) out.push({ name, about });
  }
  return out;
};

export function parseKinds(text: string, lang: Lang): Kinds {
  const raw = JSON.parse(text) as Partial<Kinds>;
  const types = cleaned(raw.types);
  const tags = cleaned(raw.tags);
  return { types: types.length ? types : defaultKinds(lang).types, tags, onlyTags: !!raw.onlyTags && tags.length > 0 };
}

/** Two devices' lists (a sync conflict): `kept`'s names and descriptions, then the names only `copy` has. */
export function mergeKinds(kept: Kinds, copy: Kinds): Kinds {
  const more = (a: Named[], b: Named[]) => [...a, ...b.filter((x) => !a.some((y) => nameKey(y.name) === nameKey(x.name)))];
  return { types: more(kept.types, copy.types), tags: more(kept.tags, copy.tags), onlyTags: kept.onlyTags };
}

export const serializeKinds = (k: Kinds) => `${JSON.stringify({ version: 1, types: cleaned(k.types), tags: cleaned(k.tags), onlyTags: k.onlyTags }, null, 2)}\n`;

/** Where a document goes whose type fits none: the last one. */
export const fallbackType = (k: Kinds) => k.types.at(-1)?.name ?? '';

/** The list as the model reads it: one name a line, with its description. */
export const describedList = (list: Named[]) => list.map((x) => `- ${x.name}${x.about ? `: ${x.about}` : ''}`).join('\n');
