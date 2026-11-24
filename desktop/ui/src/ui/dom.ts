/**
 * Minimal typed DOM builders. No framework: the whole launcher is hand-built
 * DOM so the bundle stays tiny and the WebView has nothing to hydrate.
 */

export type Child = Node | string | number | null | undefined | false;

type AttrValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ((event: Event) => void);

/**
 * Create an element.
 *
 * - keys starting with `on` and holding a function become event listeners;
 * - `class` / `className` set the class list;
 * - `true` renders a bare attribute, `false` / `null` / `undefined` are omitted.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, AttrValue> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === "function") {
        const eventName = key.startsWith("on") ? key.slice(2).toLowerCase() : key;
        el.addEventListener(eventName, value as EventListener);
        continue;
      }
      if (key === "class" || key === "className") {
        el.className = String(value);
        continue;
      }
      if (value === true) {
        el.setAttribute(key, "");
        continue;
      }
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/** Append children, skipping empty entries. */
export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(document.createTextNode(String(child)));
    } else {
      parent.appendChild(child);
    }
  }
}

/** Replace the content of a node. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** Remove all children. */
export function clear(node: Element): void {
  node.replaceChildren();
}

/** Set CSS custom properties / inline styles from a record. */
export function cssVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }
}

/** Find a required element by selector; throws early instead of returning null. */
export function need<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`UI element not found: ${selector}`);
  return found;
}

/** Return a listener that runs at most once. */
export function once<T extends Event>(target: EventTarget, type: string, handler: (event: T) => void): void {
  target.addEventListener(type, handler as EventListener, { once: true });
}
