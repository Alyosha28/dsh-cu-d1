/**
 * CR-06 — RunController: the audit write chain is poisoned by a single failure,
 * and the user's `stop` is revocable by the model-callable `resume`.
 *
 *  - `record()` chains with `.then()` and no `.catch()`, so one rejected
 *    `audit.append` turns `this.pending` into a permanently rejected promise:
 *    every later audit event is silently dropped and `/api/audit` answers 500.
 *  - `resume()` clears `stopped`/`takeover`, and `browser_control`/`computer_control`
 *    exposes `resume` to the model (index.ts control tool action enum), so a stop
 *    the user issued from the control page can be undone by the agent.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { RunController } from '../../../packages/dsh-cu-core/src/run-controller.ts'
import type { AuditStore } from '../../../packages/dsh-cu-core/src/audit.ts'

const agent = { id: 'agent-1' } as any

// Part of the finding: a transient audit failure escapes as an *unhandled*
// rejection in the host process. Swallow it here so the PoC run stays readable.
const swallow = (): void => undefined
process.on('unhandledRejection', swallow)
afterAll(() => { process.off('unhandledRejection', swallow) })

class FlakyAudit {
  readonly events: any[] = []
  failOnce = true
  async append(event: any): Promise<any> {
    if (this.failOnce) {
      this.failOnce = false
      throw new Error('EACCES: permission denied, open audit.jsonl')
    }
    this.events.push(event)
    return { id: String(this.events.length), at: new Date().toISOString(), ...event }
  }
  async list(): Promise<any[]> {
    return this.events
  }
}

describe('CR-06 run controller', () => {
  it('one audit write failure loses every later event and breaks /api/audit', async () => {
    const audit = new FlakyAudit()
    const controller = new RunController(audit as unknown as AuditStore)
    controller.start(agent, 'browser_subgoal')      // record #1 -> rejects
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.finish(agent, 'success', 'independently_verified', 'd1')  // record #2 -> dropped
    controller.start(agent, 'browser_subgoal')      // record #3 -> dropped
    controller.finish(agent, 'success', 'independently_verified', 'd1')

    await expect(controller.auditEvents()).rejects.toThrow('EACCES')
    expect(audit.events).toHaveLength(0)            // nothing was ever persisted
    await controller.auditEvents().catch(() => undefined)  // drain the poisoned chain
  })

  it('the model-callable resume() revokes a user stop', () => {
    const controller = new RunController(undefined)
    const run = controller.start(agent, 'browser_subgoal')
    expect(controller.admit(agent)).toBeNull()

    controller.stop(agent)                          // user pressed Stop on the control page
    expect(controller.admit(agent)).toEqual({ status: 'stopped', reason: 'stopped_by_user' })
    // start() honours the stop...
    expect(() => controller.start(agent, 'browser_subgoal')).not.toThrow()
    expect(controller.admit(agent)).toMatchObject({ status: 'stopped' })

    controller.resume(agent)                        // ...until the agent calls resume
    expect(controller.admit(agent)).toBeNull()
    const revived = controller.start(agent, 'browser_subgoal')
    expect(revived.id).not.toBe('')                 // a real run again
    run.signal.addEventListener('abort', () => undefined)
  })

  it('takeover is revocable the same way', () => {
    const controller = new RunController(undefined)
    controller.start(agent, 'browser_subgoal')
    controller.takeover(agent)
    expect(controller.admit(agent)).toMatchObject({ status: 'takeover' })
    controller.resume(agent)
    expect(controller.admit(agent)).toBeNull()
  })

  it('finish() without an active run records nothing (terminal state can vanish)', () => {
    const audit = new FlakyAudit()
    audit.failOnce = false
    const controller = new RunController(audit as unknown as AuditStore)
    controller.finish(agent, 'blocked', 'credentials_unavailable', 'human')
    expect(audit.events).toHaveLength(0)
  })

  it('concurrent start() is rejected, but a stopped agent still counts as inactive', () => {
    const controller = new RunController(undefined)
    controller.start(agent, 'browser_subgoal')
    expect(() => controller.start(agent, 'browser_subgoal')).toThrow('already active')
  })
})
