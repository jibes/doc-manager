import { Parser } from 'htmlparser2';

/** A minimal element tree: enough for OPF, NCX, nav and chapter markup, on web and native alike. */
export type XNode = { name: string; attrs: Record<string, string>; children: (XNode | string)[]; parent?: XNode };

/**
 * Parses markup into an XNode tree. `xml`: case-sensitive XML (OPF, NCX); otherwise forgiving HTML parsing
 * with XHTML self-closing tags and HTML entities (chapters often use &nbsp; and friends).
 */
export function parseMarkup(src: string, xml: boolean): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  let cur = root;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const node: XNode = { name, attrs, children: [], parent: cur };
        cur.children.push(node);
        cur = node;
      },
      ontext(text) {
        const last = cur.children[cur.children.length - 1];
        if (typeof last === 'string') cur.children[cur.children.length - 1] = last + text;
        else cur.children.push(text);
      },
      onclosetag() {
        if (cur.parent) cur = cur.parent;
      },
    },
    xml ? { xmlMode: true, decodeEntities: true } : { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true, decodeEntities: true },
  );
  parser.write(src);
  parser.end();
  return root;
}

/** Local name without namespace prefix: `dc:title` → `title`. */
export const local = (name: string) => name.slice(name.indexOf(':') + 1).toLowerCase();

export function* walk(n: XNode): Generator<XNode> {
  for (const c of n.children)
    if (typeof c !== 'string') {
      yield c;
      yield* walk(c);
    }
}

export const find = (n: XNode, pred: (x: XNode) => boolean): XNode | undefined => {
  for (const x of walk(n)) if (pred(x)) return x;
  return undefined;
};

export const findAll = (n: XNode, pred: (x: XNode) => boolean): XNode[] => [...walk(n)].filter(pred);

export const kids = (n: XNode) => n.children.filter((c): c is XNode => typeof c !== 'string');

export function textOf(n: XNode): string {
  return n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}

/** Attribute by local name (`epub:type`, `xlink:href`, `properties`). */
export const attr = (n: XNode, name: string): string | undefined => {
  if (name in n.attrs) return n.attrs[name];
  for (const [k, v] of Object.entries(n.attrs)) if (local(k) === name.toLowerCase()) return v;
  return undefined;
};
