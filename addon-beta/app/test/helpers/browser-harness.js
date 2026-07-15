'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

class BrowserEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }

  preventDefault() {
    if (this.cancelable !== false) this.defaultPrevented = true;
  }
}

class BrowserEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, once: options === true || options?.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener));
  }

  dispatchEvent(event) {
    if (!event || typeof event.type !== 'string') throw new TypeError('Event type is required');
    if (!event.target) event.target = this;
    event.currentTarget = this;
    const entries = [...(this.listeners.get(event.type) || [])];
    for (const entry of entries) {
      entry.listener.call(this, event);
      if (entry.once) this.removeEventListener(event.type, entry.listener);
    }
    return !event.defaultPrevented;
  }
}

class BrowserNode extends BrowserEventTarget {
  constructor(ownerDocument, nodeType) {
    super();
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get isConnected() {
    if (this.nodeType === 9) return true;
    return Boolean(this.parentNode?.isConnected);
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(String(value ?? ''));
  }

  _normalize(node) {
    if (node instanceof BrowserNode) return node;
    return this.ownerDocument.createTextNode(String(node));
  }

  append(...nodes) {
    for (const candidate of nodes) {
      const node = this._normalize(candidate);
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) this.appendChild(child);
      } else {
        this.appendChild(node);
      }
    }
  }

  appendChild(candidate) {
    const node = this._normalize(candidate);
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.appendChild(child);
      return node;
    }
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  prepend(...nodes) {
    const normalized = [];
    for (const candidate of nodes) {
      const node = this._normalize(candidate);
      if (node.nodeType === 11) normalized.push(...node.childNodes);
      else normalized.push(node);
    }
    for (const node of [...normalized].reverse()) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('Node is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1 && matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class BrowserText extends BrowserNode {
  constructor(ownerDocument, value) {
    super(ownerDocument, 3);
    this.data = String(value);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? '');
  }
}

class BrowserClassList {
  constructor(element) {
    this.element = element;
  }

  _values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  _write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...tokens) {
    const values = this._values();
    for (const token of tokens) values.add(token);
    this._write(values);
  }

  remove(...tokens) {
    const values = this._values();
    for (const token of tokens) values.delete(token);
    this._write(values);
  }

  contains(token) {
    return this._values().has(token);
  }

  toggle(token, force) {
    const values = this._values();
    const enabled = force === undefined ? !values.has(token) : Boolean(force);
    if (enabled) values.add(token);
    else values.delete(token);
    this._write(values);
    return enabled;
  }
}

class BrowserElement extends BrowserNode {
  constructor(ownerDocument, tagName) {
    super(ownerDocument, 1);
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.classList = new BrowserClassList(this);
    this.dataset = {};
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.tabIndex = 0;
    this._value = '';
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  set href(value) {
    this.setAttribute('href', value);
  }

  get src() {
    return this.getAttribute('src') || '';
  }

  set src(value) {
    this.setAttribute('src', value);
  }

  get options() {
    return this.localName === 'select'
      ? this.children.filter((child) => child.localName === 'option')
      : [];
  }

  get value() {
    if (this.localName === 'select') {
      const option = this.options.find((candidate) => candidate.selected) || this.options[0];
      return option ? option.value : this._value;
    }
    return this._value;
  }

  set value(value) {
    this._value = String(value ?? '');
    if (this.localName === 'select') {
      for (const option of this.options) option.selected = option.value === this._value;
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  focus() {
    if (this.isConnected) this.ownerDocument.activeElement = this;
  }

  click() {
    if (!this.disabled) this.dispatchEvent(new BrowserEvent('click', { cancelable: true }));
  }

  showModal() {
    this.open = true;
    this.setAttribute('open', '');
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.removeAttribute('open');
    this.dispatchEvent(new BrowserEvent('close'));
  }
}

class BrowserFragment extends BrowserNode {
  constructor(ownerDocument) {
    super(ownerDocument, 11);
  }
}

class BrowserDocument extends BrowserNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.title = '';
    this.body = new BrowserElement(this, 'body');
    this.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new BrowserElement(this, tagName);
  }

  createTextNode(value) {
    return new BrowserText(this, value);
  }

  createDocumentFragment() {
    return new BrowserFragment(this);
  }

  getElementById(id) {
    return this.querySelector(`#${String(id)}`);
  }
}

function matchesSimple(element, selector) {
  const tag = /^[a-zA-Z][\w-]*/.exec(selector)?.[0];
  if (tag && element.localName !== tag.toLowerCase()) return false;

  const id = /#([\w-]+)/.exec(selector)?.[1];
  if (id && element.id !== id) return false;

  for (const match of selector.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(match[1])) return false;
  }

  for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    const [, name, expected] = match;
    if (!element.hasAttribute(name)) return false;
    if (expected !== undefined && element.getAttribute(name) !== expected) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !matchesSimple(element, parts.at(-1))) return false;
  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index--) {
    while (ancestor && (ancestor.nodeType !== 1 || !matchesSimple(ancestor, parts[index]))) {
      ancestor = ancestor.parentNode;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function appendElement(document, tagName, id, parent = document.body) {
  const element = document.createElement(tagName);
  if (id) element.id = id;
  parent.appendChild(element);
  return element;
}

function createSkeleton(document) {
  appendElement(document, 'img', 'ambient-bg');
  appendElement(document, 'div', 'ambient-grain');
  const nav = appendElement(document, 'nav', 'nav');
  const searchForm = appendElement(document, 'form', 'media-search-form', nav);
  appendElement(document, 'input', 'media-search-input', searchForm);
  appendElement(document, 'div', 'nav-libraries', nav);
  const settingsLink = appendElement(document, 'a', '', nav);
  settingsLink.dataset.nav = 'settings';
  appendElement(document, 'main', 'app');
  const playbackControls = appendElement(document, 'section', 'playback-controls');
  playbackControls.hidden = true;
  const toast = appendElement(document, 'div', 'toast');
  toast.className = 'toast hidden';
}

function defaultApi() {
  return {
    imageUrl: (ref) => `api/media/images/${encodeURIComponent(ref)}`,
    getBootstrap: async () => ({
      mediaServer: { configured: false, authenticated: false, ready: false },
      playback: { hasTargets: false },
    }),
    getLibraries: async () => ({ items: [] }),
    getPlaybackTargets: async () => ({ targets: [] }),
    getPlaybackSessions: async () => ({ sessions: [] }),
  };
}

function createBrowserHarness({ api = {}, settingsRenders = [] } = {}) {
  const document = new BrowserDocument();
  createSkeleton(document);
  const windowTarget = new BrowserEventTarget();
  const location = { hash: '' };
  const window = {
    document,
    location,
    confirm: () => true,
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    dispatchEvent: windowTarget.dispatchEvent.bind(windowTarget),
  };
  document.defaultView = window;

  let nextTimerId = 1;
  const timers = new Map();
  const sandbox = {
    AbortController,
    AbortSignal,
    Event: BrowserEvent,
    Headers,
    URLSearchParams,
    api: { ...defaultApi(), ...api },
    clearTimeout: (id) => timers.delete(id),
    console,
    decodeURIComponent,
    document,
    encodeURIComponent,
    location,
    settingsRenders,
    setTimeout: (callback, _delay) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    window,
  };
  const context = vm.createContext(sandbox);

  function evaluate(source) {
    return vm.runInContext(source, context);
  }

  function load(relativePath) {
    const filename = path.join(PUBLIC_ROOT, relativePath);
    const source = fs.readFileSync(filename, 'utf8');
    return vm.runInContext(source, context, { filename });
  }

  return {
    BrowserEvent,
    context,
    document,
    evaluate,
    load,
    runTimer(id) {
      const callback = timers.get(id);
      timers.delete(id);
      if (callback) callback();
    },
    timers,
    window,
  };
}

function loadMediaLauncherApp(harness, { actualSettingsView = false } = {}) {
  harness.load('target-selection.js');
  harness.load('media-model.js');
  harness.load('components/poster-grid.js');
  harness.load('components/detail-view.js');
  if (actualSettingsView) {
    harness.load('components/settings-view.js');
  } else {
    harness.evaluate(`
      async function renderSettingsView() {
        const plan = settingsRenders.shift() || {};
        if (typeof plan.started === 'function') plan.started();
        if (plan.wait) await plan.wait;
        if (plan.error) throw plan.error;
        const heading = document.createElement('h1');
        heading.textContent = plan.title || 'Settings';
        heading.tabIndex = -1;
        appEl.replaceChildren(heading);
      }
    `);
  }
  harness.load('app.js');
  return harness;
}

async function flushMicrotasks(turns = 4) {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

module.exports = {
  BrowserEvent,
  createBrowserHarness,
  flushMicrotasks,
  loadMediaLauncherApp,
};
