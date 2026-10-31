import { expect, it } from 'vitest'
import { formatTemplate, resolveLocale, uiStrings } from '../src/locale.ts'

it('resolves Chinese and English UI strings without changing stable codes', () => {
  expect(resolveLocale(undefined)).toBe('zh')
  expect(resolveLocale('en')).toBe('en')
  expect(resolveLocale('fr')).toBe('zh')
  const zh = uiStrings('zh')
  const en = uiStrings('en')
  expect(zh.panel.pause).toBe('暂停')
  expect(en.panel.pause).toBe('Pause')
  expect(zh.phases.paused).toBe('已暂停')
  expect(en.phases.observing).toBe('Reading the interface')
  expect(zh.operations.CLICK).toBe('点击')
  expect(en.approvals.allowOnce).toBe('Allow once')
})

it('formats approval templates without leaking unknown placeholders', () => {
  expect(formatTemplate('Allow {operation} on {target}', { operation: 'CLICK', target: 'Save' })).toBe('Allow CLICK on Save')
  expect(formatTemplate('Allow {operation}', {})).toBe('Allow {operation}')
})
