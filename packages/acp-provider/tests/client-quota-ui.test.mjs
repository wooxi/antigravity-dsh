// UI tests for the Antigravity settings card and composer parameter rows in src/client.js / lib/client.js.
// 会话输入栏的额度药丸已按需求移除，只保留「不再注册」的防回归断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcClientPath = join(root, 'src', 'client.js')
const libClientPath = join(root, 'lib', 'client.js')

const FIXED_NOW = Date.parse('2026-11-04T12:00:00.000Z')
const isoAfterHours = (hours) => new Date(FIXED_NOW + hours * 3_600_000).toISOString()

function createMiniReact() {
  let active = null

  const flatten = (items, out = []) => {
    for (const item of items) {
      if (Array.isArray(item)) flatten(item, out)
      else if (item !== null && item !== undefined && typeof item !== 'boolean') out.push(item)
    }
    return out
  }

  const depsEqual = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!Object.is(a[i], b[i])) return false
    }
    return true
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = flatten(children)
      const nextProps = { ...(props || {}) }
      if (flat.length > 0) nextProps.children = flat
      return { __vnode: true, type, props: nextProps, ref: props ? props.ref : undefined }
    },
    useState(initial) {
      const inst = active
      const idx = inst.hookIndex++
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = inst.hooks[idx]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          inst.root.render()
        }
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const inst = active
      const idx = inst.hookIndex++
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: initial }
      return inst.hooks[idx]
    },
    useCallback(fn, deps) {
      const inst = active
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsEqual(prev.deps, deps)) inst.hooks[idx] = { fn, deps }
      return inst.hooks[idx].fn
    },
    useEffect(fn, deps) {
      const inst = active
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsEqual(prev.deps, deps)) {
        const slot = { deps, cleanup: prev ? prev.cleanup : undefined }
        inst.hooks[idx] = slot
        inst.root.pendingEffects.push(() => {
          if (typeof slot.cleanup === 'function') slot.cleanup()
          slot.cleanup = fn()
        })
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      React.useEffect(() => subscribe(() => activeRootRender()), [subscribe])
      const inst = active
      const activeRootRender = () => inst.root.render()
      return getSnapshot()
    },
  }

  function mount(Component, initialProps) {
    const root = {
      props: initialProps,
      instances: new Map(),
      pendingEffects: [],
      tree: null,
      render() {
        const seen = new Set()
        const renderVNode = (vnode, path) => {
          if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null
          if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode)
          if (!vnode.__vnode) return null

          if (typeof vnode.type === 'function') {
            seen.add(path)
            let inst = root.instances.get(path)
            if (!inst) {
              inst = { hooks: [], hookIndex: 0, root }
              root.instances.set(path, inst)
            }
            const prev = active
            active = inst
            inst.hookIndex = 0
            const rendered = vnode.type(vnode.props)
            active = prev
            return renderVNode(rendered, `${path}>f`)
          }

          const children = (vnode.props.children || [])
            .map((child, i) => renderVNode(child, `${path}/${i}`))
            .filter((child) => child !== null)
          const host = { tag: vnode.type, props: vnode.props, children }
          if (vnode.ref && typeof vnode.ref === 'object') {
            vnode.ref.current = {
              node: host,
              contains: (target) => Boolean(target && target.__insideRoot === vnode.ref),
            }
          }
          return host
        }

        root.tree = renderVNode(React.createElement(Component, root.props), 'root')
        for (const [key, inst] of root.instances.entries()) {
          if (!seen.has(key)) {
            for (const h of inst.hooks) {
              if (h && typeof h.cleanup === 'function') h.cleanup()
            }
            root.instances.delete(key)
          }
        }
        while (root.pendingEffects.length > 0) {
          const batch = root.pendingEffects.splice(0)
          for (const run of batch) run()
        }
        return root.tree
      },
      rerender(nextProps) {
        root.props = nextProps
        return root.render()
      },
      unmount() {
        for (const inst of root.instances.values()) {
          for (const h of inst.hooks) {
            if (h && typeof h.cleanup === 'function') h.cleanup()
          }
        }
        root.instances.clear()
        root.tree = null
      },
    }
    root.render()
    return root
  }

  return { React, mount }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  return (node.children || []).map(textOf).join('')
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node === 'string') return acc
  if (predicate(node)) acc.push(node)
  for (const child of node.children || []) findAll(child, predicate, acc)
  return acc
}

function findOne(node, predicate) {
  return findAll(node, predicate)[0] || null
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function loadClientPlugin({ language = 'zh-CN', remoteService } = {}) {
  const { React, mount } = createMiniReact()
  const listeners = new Map()
  const document = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn)
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event)
    },
  }

  let loadedSpec = null
  const window = {
    __ModuleLoader__: {
      load(spec) {
        loadedSpec = spec
      },
    },
  }

  class CustomDate extends Date {
    static now() {
      return FIXED_NOW
    }
  }

  const intervals = new Set()
  const sandbox = {
    window,
    document,
    navigator: { language },
    Date: CustomDate,
    console,
    TypeError,
    Error,
    Promise,
    Object,
    Array,
    Number,
    String,
    Math,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval(fn) {
      const token = { fn }
      intervals.add(token)
      return token
    },
    clearInterval(token) {
      intervals.delete(token)
    },
  }

  const code = readFileSync(libClientPath, 'utf8')
  vm.runInNewContext(code, sandbox, { filename: libClientPath })
  assert.ok(loadedSpec, 'window.__ModuleLoader__.load should receive module spec')
  assert.equal(loadedSpec.id, 'dsh-llm-antigravity-acp')

  const plugin = loadedSpec.factory((pkg) => {
    if (pkg === 'react') return React
    throw new Error(`Unexpected require(${pkg})`)
  })

  const registered = new Map()
  let currentModel = { provider: 'antigravity', model: 'gemini-4-argon' }
  const storeSubscribers = new Set()
  const store = {
    getSnapshot: () => ({ current: currentModel }),
    subscribe: (cb) => {
      storeSubscribers.add(cb)
      return () => storeSubscribers.delete(cb)
    },
    setCurrent(next) {
      currentModel = next
      for (const cb of [...storeSubscribers]) cb()
    },
  }

  const service = remoteService || {
    status: async () => ({
      state: 'ready',
      version: '1.2.3',
      contextWindow: 1_048_576,
      configuredContextWindow: 0,
      defaultEffort: 'high',
      longDecodeContinuations: 3,
      unlock: { status: 'unlocked' },
    }),
    quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
    warmup: async () => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576 }),
    configure: async (patch) => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576, ...patch }),
  }

  const slots = {
    inject(_slotName, registerFn) {
      return registerFn()
    },
    register(meta, Component) {
      registered.set(meta.name, { meta, Component })
      return () => registered.delete(meta.name)
    },
  }

  const ctx = {
    remote: { $mount: () => () => undefined },
    slots,
    modelDirectories: { directoryFor: () => ({ store }) },
    effect(fn) {
      fn()
    },
    get(key) {
      if (key === 'remote.antigravityAcp') return service
      return undefined
    },
    inject(_deps, cb) {
      cb(ctx)
    },
  }

  plugin.apply(ctx)
  return { registered, mount, document, store, intervals }
}

function recordingService(windowValue = 0, decodeValue = 3) {
  const patches = []
  const service = {
    status: async () => ({
      state: 'ready',
      version: '1.5.1',
      contextWindow: 1_048_576,
      configuredContextWindow: windowValue,
      defaultEffort: 'high',
      longDecodeContinuations: decodeValue,
      unlock: { status: 'unlocked' },
    }),
    quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
    warmup: async () => ({ state: 'ready', version: '1.5.1', contextWindow: 1_048_576 }),
    configure: async (patch) => {
      patches.push(patch)
      if ('contextWindow' in patch) windowValue = patch.contextWindow
      if ('longDecodeContinuations' in patch) decodeValue = patch.longDecodeContinuations
      return service.status()
    },
  }
  return { service, patches }
}

test('lib/client.js stays in sync with src/client.js', () => {
  assert.equal(readFileSync(libClientPath, 'utf8'), readFileSync(srcClientPath, 'utf8'))
})

test('SettingsCard sorts weekly quota ahead of 5h window', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.2.3',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        unlock: { status: 'unlocked' },
      }),
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          name: 'Gemini',
          description: '',
          buckets: [
            { id: 'five_hour', name: '5-hour', window: '5h', remainingFraction: 0.95, resetTime: isoAfterHours(4) },
            { id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.68, resetTime: isoAfterHours(62) },
          ],
        }],
      }),
      warmup: async () => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576 }),
      configure: async (patch) => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576, ...patch }),
    },
  })

  const settingsSlot = registered.get('settings.section')
  assert.ok(settingsSlot, 'SettingsCard should register on settings.section')
  const view = mount(settingsSlot.Component, settingsSlot.meta.inject())
  await flush()

  const bucketSpans = findAll(view.tree, (n) => n.props && 'data-bucket-window' in n.props)
  assert.deepEqual(bucketSpans.map((n) => n.props['data-bucket-window']), ['weekly', '5h'])
  assert.match(textOf(bucketSpans[0]), /每周.*68%/)
  assert.match(textOf(bucketSpans[1]), /5 小时.*95%/)

  view.unmount()
})
test('SettingsCard renders live settings as value rows that apply the chosen option', async () => {
  const { service, patches } = recordingService()
  const { registered, mount } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const rows = findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)
  assert.deepEqual(rows.map(textOf), ['上下文窗口自动 (1M)', '默认思考High', '超长续写3 段'])
  assert.equal(rows.every((row) => row.props.disabled === false), true)

  // The row opens the choice list inline; the current value carries the check.
  rows[0].props.onClick()
  await flush()
  const options = findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)
  assert.deepEqual(options.map(textOf), ['自动 (1M)', '900K', '512K', '256K'])
  assert.equal(options[0].props['aria-checked'], true)

  options[2].props.onClick()
  await flush()
  // Patches cross the sandbox realm, so compare their data, not their prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 512000 }])
  assert.match(textOf(findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[0]), /上下文窗口512K/)

  // The list collapses after a choice and the next row applies its own patch.
  assert.equal(findAll(view.tree, (node) => node.props['aria-checked'] !== undefined).length, 0)
  findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[2].props.onClick()
  await flush()
  findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)[2].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 512000 }, { longDecodeContinuations: 8 }])
  view.unmount()
})

test('composer parameter rows expose the same live settings for Antigravity only', async () => {
  const { service, patches } = recordingService()
  const { registered, mount, store } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('conversation.input.model.parameters')
  assert.ok(slot, 'the plugin registers the composer parameter slot')
  const owner = { locked: false, dismiss() {}, reportFailure() {} }
  const view = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner })
  await flush()

  const rows = findAll(view.tree, (node) => node.props && node.props.role === 'menuitem')
  assert.deepEqual(rows.map(textOf), ['上下文自动 (1M)', '超长续写3 段'])

  rows[0].props.onClick()
  await flush()
  const options = findAll(view.tree, (node) => node.props.role === 'menuitemradio')
  assert.deepEqual(options.map(textOf), ['自动 (1M)', '900K', '512K', '256K'])
  assert.equal(options[0].props['aria-checked'], true)
  options[1].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 900000 }])
  assert.match(textOf(findAll(view.tree, (node) => node.props.role === 'menuitem')[0]), /900K/)

  // Locked rows refuse changes.
  view.unmount()
  const locked = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner, locked: true })
  await flush()
  const lockedRows = findAll(locked.tree, (node) => node.props && node.props.role === 'menuitem')
  assert.equal(lockedRows.every((row) => row.props.disabled === true), true)
  lockedRows[0].props.onClick()
  await flush()
  assert.equal(patches.length, 1, 'a locked row applies nothing')
  locked.unmount()

  // Another provider renders nothing.
  store.setCurrent({ provider: 'deepseek', model: 'deepseek-chat' })
  const other = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner })
  await flush()
  assert.equal(other.tree, null)
  other.unmount()
})

test('会话栏不再注册额度药丸（额度只在设置页展示）', () => {
  const { registered } = loadClientPlugin()
  assert.equal(registered.has('conversation.input.right'), false, 'conversation.input.right 不应再被注册')
  assert.ok(registered.has('conversation.input.model.parameters'), '模型参数行仍需注册')
  assert.ok(registered.has('settings.section'), '设置页额度卡片仍需注册')
})
