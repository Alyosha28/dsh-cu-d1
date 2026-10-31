import { expect, it } from 'vitest'
import { validateDecision } from '../src/actions.ts'
import type { Observation } from '../src/types.ts'

const observation: Observation = {
  snapshot_id: 'snapshot-1', version: 0, url: 'app://1/2', title: 'Document',
  truncated: false, can_scroll_up: false, can_scroll_down: false,
  elements: [{
    id: '4', role: 'AXDocument', name: 'Body', value: '', actions: ['paste'], enabled: true, focused: false,
  }],
}

it('validates literal text and a paste-capable native target', () => {
  expect(() => validateDecision(observation, {
    operation: 'PASTE_TEXT', target: '4', text: 'Document body',
  })).not.toThrow()
  expect(() => validateDecision(observation, {
    operation: 'PASTE_TEXT', target: '4', text: '',
  })).toThrow('PASTE_TEXT requires extracted literal text')
  expect(() => validateDecision(observation, {
    operation: 'PASTE_TEXT', target: 'missing', text: 'Document body',
  })).toThrow('Target missing is not valid for PASTE_TEXT')
})

it('validates literal text for a visual paste target', () => {
  const visual = { ...observation, screenshot: {
    bounds: { x: 0, y: 0, width: 800, height: 600 }, pixelWidth: 800, pixelHeight: 600, windowId: 2,
  } }
  const box = { left: 0.1, right: 0.9, top: 0.1, bottom: 0.9 }
  expect(() => validateDecision(visual, {
    operation: 'PASTE_TEXT', target: null, text: 'Document body', box,
  })).not.toThrow()
  expect(() => validateDecision(visual, {
    operation: 'PASTE_TEXT', target: null, box,
  })).toThrow('PASTE_TEXT requires extracted literal text')
})
