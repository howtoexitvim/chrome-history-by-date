const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Use synthetic browser results only: tests never read a browser profile.
function popup() {
  class Element {
    constructor() { this.children = []; this.value = ''; this.style = {}; this.listeners = {}; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute() {}
    querySelectorAll() { return []; }
  }
  const elements = Object.fromEntries(['list', 'q', 'menu', 'more', 'clear', 'tabs'].map(id => [id, new Element()]));
  const callbacks = { all: [], closed: [], devices: [] };
  const chrome = {
    runtime: { getURL: url => `chrome-extension://fixture${url}` },
    history: { search: (_, cb) => callbacks.all.push(cb) },
    sessions: {
      getRecentlyClosed: (_, cb) => callbacks.closed.push(cb),
      getDevices: (_, cb) => callbacks.devices.push(cb),
    },
  };
  const context = vm.createContext({
    URL, Intl, Date, Map, chrome, window: {},
    setTimeout: () => 1, clearTimeout() {},
    document: {
      getElementById: id => elements[id], querySelector: () => elements.tabs,
      createElement: () => new Element(), createDocumentFragment: () => new Element(),
      addEventListener() {},
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8'), context);
  return { elements, callbacks, context, run: code => vm.runInContext(code, context) };
}

for (const oldView of ['all', 'closed', 'devices']) {
  test(`late ${oldView} callback cannot replace the selected view`, () => {
    const p = popup();
    if (oldView !== 'all') p.run(`selectView('${oldView}')`);
    const newView = oldView === 'closed' ? 'all' : 'closed';
    p.run(`selectView('${newView}')`);
    p.callbacks[newView].at(-1)([]);
    const displayed = p.elements.list.textContent;
    p.callbacks[oldView].at(-1)([]);
    assert.equal(p.elements.list.textContent, displayed);
    p.context.chrome.runtime.lastError = { message: 'stale failure' };
    p.callbacks[oldView].at(-1)([]);
    assert.equal(p.elements.list.textContent, displayed);
  });
}

test('a newer search wins even when an older search finishes later', () => {
  const p = popup();
  const old = p.callbacks.all[0];
  p.elements.q.value = 'new query';
  p.run('load()');
  p.callbacks.all.at(-1)([]);
  assert.equal(p.elements.list.textContent, 'No matching history');
  old([]);
  assert.equal(p.elements.list.textContent, 'No matching history');
});

test('typing invalidates an outstanding search before the debounce expires', () => {
  const p = popup();
  p.elements.list.textContent = 'current results';
  p.elements.q.value = 'new query';
  p.elements.q.listeners.input();
  p.callbacks.all[0]([]);
  assert.equal(p.elements.list.textContent, 'current results');
});
