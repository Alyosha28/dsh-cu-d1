import { z } from 'zod'
import { taskPolicyInputSchema } from './policy.ts'


export const verificationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_visible'), text: z.string().min(1).describe('Text that must be visible on the page or window.') }).strict(),
  z.object({ type: z.literal('url_contains'), value: z.string().min(1).describe('Substring that the current URL must contain.') }).strict(),
  z.object({ type: z.literal('input_value'), label: z.string().min(1).describe('Accessible label of the field.'), value: z.string().describe('Exact value the field must contain.') }).strict(),
  z.object({ type: z.literal('checkbox'), label: z.string().min(1).describe('Accessible label of the checkbox.'), checked: z.boolean().describe('Required checked state.') }).strict(),
  z.object({ type: z.literal('custom'), name: z.string().min(1).describe('Provider-specific verifier name.'), args: z.record(z.string(), z.json()).optional().describe('Arguments for the provider-specific verifier.') }).strict(),
])
export type Verification = z.infer<typeof verificationSchema>

/** Upper bound on any merged assertion set (Skill assertions + caller assertions). */
export const MAX_VERIFICATIONS = 12

export const subgoalInput = z.object({
  goal: z.string().min(1).max(8000).describe('One bounded outcome. Name the region or control when the target is ambiguous.'),
  url: z.string().optional().describe('Optional URL to navigate once before the loop.'),
  verify: z.array(verificationSchema).min(1).max(MAX_VERIFICATIONS).describe('Independent postconditions. A model-selected DONE does not bypass them.'),
  maxSteps: z.number().int().min(1).max(50).optional().describe('Maximum dynamic actions in this subgoal.'),
  policy: taskPolicyInputSchema.optional().describe('Risk and credential policy for this subgoal. risk may only raise the provider floor; pre-authorization is a host configuration and not a tool argument.'),
  inputs: z.record(z.string(), z.string()).optional().describe('Values for verified Skill placeholders.'),
  skillId: z.string().optional().describe('Request a specific verified Skill fast path.'),
}).strict()
export type SubgoalInput = z.infer<typeof subgoalInput>

export type RunStatus = 'success' | 'blocked' | 'escalated' | 'confirmation_required' | 'paused' | 'stopped' | 'takeover'
