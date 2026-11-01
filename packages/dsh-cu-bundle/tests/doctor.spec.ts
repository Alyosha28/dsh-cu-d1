/**
 * SR-03 / SR-04 / SR-12: the doctor's own parsing rules.
 *
 * The full doctor needs a live `dsh` binary and a composed profile, so the parts
 * that decide PASS/FAIL are tested directly here: duplicate ids, the entry count,
 * and the token rule (a published default is a FAIL only while its environment
 * variable is unset).
 */
import { describe, expect, it } from 'vitest'

import { defaultTokenLines, duplicateIds, entries, entryCount, field } from '../../../scripts/plugin-doctor.mts'

const DUMP = `# == @albaincompleta/dsh-cu-bundle
- id: dsh-cu-client
  name: '@albaincompleta/dsh-cu-client'
- id: browser-use-registry
  name: '@deepseek-ai/dsh-browser-use'
- id: dsh-cu-browser
  name: '@albaincompleta/dsh-cu-browser-use-d1'
  config:
    decisionToken: !!js process.env.DSH_CU_DECISION_TOKEN || 'dsh-cu-local'
    controlToken: !!js process.env.DSH_CU_CONTROL_TOKEN || 'dsh-cu-control'
- id: dsh-cu-computer
  name: '@albaincompleta/dsh-cu-computer-use-d1'
  disabled: true
`

describe('SR-04 duplicate ids and entry counting', () => {
  it('keeps every entry block instead of letting a later row win', () => {
    const attack = `- insert:
    - id: dsh-cu-browser
      name: '@attacker/hijacked-provider'
    - id: dsh-cu-browser
      name: '@albaincompleta/dsh-cu-browser-use-d1'
`
    const list = entries(attack)
    expect(list.map(entry => field(entry.lines, 'name'))).toEqual([
      '@attacker/hijacked-provider',
      '@albaincompleta/dsh-cu-browser-use-d1',
    ])
    expect(duplicateIds(list)).toEqual([{
      id: 'dsh-cu-browser',
      count: 2,
      names: ['@attacker/hijacked-provider', '@albaincompleta/dsh-cu-browser-use-d1'],
    }])
  })

  it('reports no duplicate for a normal composition', () => {
    expect(duplicateIds(entries(DUMP))).toEqual([])
  })

  it('counts `- id:` rows, not the de-duplicated map size', () => {
    expect(entryCount(DUMP)).toBe(4)
    const doubled = `${DUMP}- id: dsh-cu-browser\n  name: '@attacker/x'\n`
    expect(entries(doubled)).toHaveLength(5)
    expect(entryCount(doubled)).toBe(5)
  })
})

describe('SR-03 control token rule', () => {
  const browser = () => entries(DUMP).find(entry => entry.id === 'dsh-cu-browser')!

  it('fails while the override variables are unset', () => {
    const found = defaultTokenLines(browser(), {})
    expect(found).toEqual([
      'decisionToken falls back to dsh-cu-local (DSH_CU_DECISION_TOKEN is unset)',
      'controlToken falls back to dsh-cu-control (DSH_CU_CONTROL_TOKEN is unset)',
    ])
  })

  it('passes once both variables are set', () => {
    const found = defaultTokenLines(browser(), { DSH_CU_DECISION_TOKEN: 'a', DSH_CU_CONTROL_TOKEN: 'b' })
    expect(found.every(line => line.includes('is overridden by'))).toBe(true)
  })

  it('still flags a literal published token that no environment variable can change', () => {
    const literal = entries(`- id: dsh-cu-browser
  name: '@albaincompleta/dsh-cu-browser-use-d1'
  config:
    controlToken: 'dsh-cu-control'
`)
    const found = defaultTokenLines(literal[0]!, { DSH_CU_CONTROL_TOKEN: 'b' })
    expect(found).toEqual(['controlToken = dsh-cu-control'])
  })

  it('ignores a token that is not a published default', () => {
    const custom = entries(`- id: dsh-cu-browser
  name: '@albaincompleta/dsh-cu-browser-use-d1'
  config:
    controlToken: 'my-own-control-token'
`)
    expect(defaultTokenLines(custom[0]!, {})).toEqual([])
  })
})
