const assert = require('node:assert/strict')

async function main() {
  let clientModule
  const style = { setAttribute() {}, remove() {}, textContent: '' }
  globalThis.document = {
    createElement: () => style,
    head: { appendChild() {} },
  }
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-foxy-bili')
        const react = {
          createElement: (...args) => args,
          useCallback: (fn) => fn,
          useEffect: () => {},
          useRef: (value) => ({ current: value }),
          useState: (value) => [value, () => {}],
        }
        clientModule = factory(() => react)
      },
    },
  }

  await import('../lib/client.js')
  assert.ok(clientModule, 'client module should be registered')
  assert.equal(clientModule.name, 'dsh-foxy-bili')
  assert.deepEqual(clientModule.inject, ['slots'])

  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject(slot, callback) {
        callback()
      },
      register(spec) {
        registered.push(spec)
      },
    },
  }
  clientModule.apply(ctx)
  assert.equal(registered.length, 2)
  assert.deepEqual(
    registered.map((x) => x.name),
    ['main', 'settings.section'],
  )
  assert.equal(registered[0].key, 'dsh-foxy-bili')
  assert.equal(registered[1].id, 'foxy-bili')
  assert.equal(registered[1].label, 'Foxy-bili')
  const page = globalThis.window.__FOXY_CONSOLE__.pages.find((item) => item.id === 'dsh-foxy-bili')
  assert.ok(page)
  assert.equal(page.label, 'B站')
  assert.equal(page.order, 13)

  console.log('foxy-bili client tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
