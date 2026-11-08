import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOCKED_CONTEXT_WINDOW, UNLOCKED_CONTEXT_WINDOW, createPatchManager, parseDryRun } from '../src/patch.mjs'

const ORIGINAL = 'original-256k-binary'
const PATCHED = 'patched-1m-binary'

/**
 * 模拟 agy-patch.py：二进制内容就是状态，`--in-place` 写 PATCHED 并留 .bak。
 * @param {string} binary
 */
function fakeScript(binary) {
  const backup = `${binary}.bak`
  return async (argv) => {
    if (argv.includes('--version')) return { code: 0, stdout: '1.5.3\n', stderr: '' }
    if (argv.includes('--dry-run')) {
      const body = readFileSync(binary, 'utf8')
      return body === PATCHED
        ? { code: 0, stdout: '[=] all gates already unlocked; nothing to write\n', stderr: '' }
        : { code: 0, stdout: '[*] dry run complete: sha256 aaaaaaaaaaaa -> bbbbbbbbbbbb\n', stderr: '' }
    }
    if (argv.includes('--in-place')) {
      if (!existsSync(backup)) copyFileSync(binary, backup)
      writeFileSync(binary, PATCHED)
      return { code: 0, stdout: '[*] wrote\n', stderr: '' }
    }
    throw new Error(`unexpected argv ${argv.join(' ')}`)
  }
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-patch-test-'))
  const binary = join(dir, 'agy')
  writeFileSync(binary, ORIGINAL)
  chmodSync(binary, 0o755)
  const script = join(dir, 'agy-patch.py')
  writeFileSync(script, '# fake\n')
  const patches = createPatchManager({ binary, script, python: 'python3', run: fakeScript(binary), statusTtlMs: 0 })
  return { dir, binary, patches, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parseDryRun 三种结果', () => {
  assert.equal(parseDryRun({ code: 0, stdout: '[=] all gates already unlocked', stderr: '' }).state, 'unlocked')
  const locked = parseDryRun({ code: 0, stdout: '[*] dry run complete: sha256 7ca212748ca0 -> 73e06443e3c9', stderr: '' })
  assert.equal(locked.state, 'locked')
  assert.equal(locked.before, '7ca212748ca0')
  assert.equal(locked.after, '73e06443e3c9')
  assert.equal(parseDryRun({ code: 2, stdout: '', stderr: 'error: no such file' }).state, 'unknown')
})

test('status 报 locked 与 256K，且没有备份时不谎报', async () => {
  const box = sandbox()
  try {
    const status = await box.patches.status(true)
    assert.equal(status.locked, true)
    assert.equal(status.windowTokens, LOCKED_CONTEXT_WINDOW)
    assert.equal(status.state, 'locked')
    assert.equal(status.version, '1.5.3')
    assert.equal(status.backup.exists, false)
    assert.equal(status.backup.matchesBinary, false)
  } finally {
    box.cleanup()
  }
})

test('enable 打补丁：备份原文件、状态变 unlocked、声明 1M', async () => {
  const box = sandbox()
  try {
    const result = await box.patches.enable()
    assert.equal(result.changed, true)
    assert.equal(result.locked, false)
    assert.equal(result.windowTokens, UNLOCKED_CONTEXT_WINDOW)
    assert.equal(readFileSync(box.binary, 'utf8'), PATCHED)
    assert.equal(readFileSync(`${box.binary}.bak`, 'utf8'), ORIGINAL)
    assert.equal(result.backup.matchesBinary, false) // 备份是原始版，本来就不等于补丁版
  } finally {
    box.cleanup()
  }
})

test('enable 在已解锁时是幂等的，不再写盘', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.binary, PATCHED)
    const result = await box.patches.enable()
    assert.equal(result.changed, false)
    assert.equal(result.locked, false)
    assert.equal(existsSync(`${box.binary}.bak`), false)
  } finally {
    box.cleanup()
  }
})

test('enable 拒绝陈旧备份（agy 升级过），避免还原时版本倒退', async () => {
  const box = sandbox()
  try {
    writeFileSync(`${box.binary}.bak`, 'ancient-binary')
    await assert.rejects(() => box.patches.enable(), (error) => {
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /不是同一份/)
      return true
    })
    assert.equal(readFileSync(box.binary, 'utf8'), ORIGINAL)
  } finally {
    box.cleanup()
  }
})

test('disable 从备份原子还原，状态回到 locked', async () => {
  const box = sandbox()
  try {
    await box.patches.enable()
    const result = await box.patches.disable()
    assert.equal(result.changed, true)
    assert.equal(result.locked, true)
    assert.equal(result.windowTokens, LOCKED_CONTEXT_WINDOW)
    assert.equal(readFileSync(box.binary, 'utf8'), ORIGINAL)
    assert.equal(existsSync(`${box.binary}.restore.${process.pid}`), false)
  } finally {
    box.cleanup()
  }
})

test('disable 没有备份时拒绝，不猜', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.binary, PATCHED)
    await assert.rejects(() => box.patches.disable(), (error) => {
      assert.equal(error.code, 'CONFLICT')
      assert.match(error.message, /没有备份/)
      return true
    })
  } finally {
    box.cleanup()
  }
})

test('disable 在已锁定时是幂等的', async () => {
  const box = sandbox()
  try {
    const result = await box.patches.disable()
    assert.equal(result.changed, false)
    assert.equal(result.locked, true)
  } finally {
    box.cleanup()
  }
})
