/** Небольшой разбор XML без зависимостей: элементы, атрибуты, текст. Для выписок ЕГРН этого достаточно. */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** Имя без пространства имён: «ns:cad_number» → «cad_number». */
const local = (name: string) => name.slice(name.indexOf(":") + 1);

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1] as XmlNode;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1] as string)] = decode(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: local(m[3]), attrs, children: [], text: "" };
      top.children.push(node);
      if (m[5] !== "/") stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

/** Все элементы, путь к которым оканчивается на path («params/area/value»). */
export function findAll(node: XmlNode, path: string): XmlNode[] {
  const want = path.split("/");
  const out: XmlNode[] = [];
  const walk = (n: XmlNode, trail: string[]) => {
    const t = [...trail, n.name];
    if (t.length >= want.length && want.every((w, i) => t[t.length - want.length + i] === w)) out.push(n);
    for (const c of n.children) walk(c, t);
  };
  walk(node, []);
  return out;
}

/** Текст первого элемента по пути; пустой — undefined. */
export function textAt(node: XmlNode, ...paths: string[]): string | undefined {
  for (const p of paths) {
    for (const n of findAll(node, p)) {
      const t = n.text.replace(/\s+/g, " ").trim();
      if (t) return t;
    }
  }
  return undefined;
}

/** Значение атрибута первого элемента с таким именем. */
export function attrAt(node: XmlNode, element: string, attr: string): string | undefined {
  for (const n of findAll(node, element)) {
    const v = n.attrs[attr]?.trim();
    if (v) return v;
  }
  return undefined;
}
