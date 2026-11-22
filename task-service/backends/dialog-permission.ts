/**
 * Classifies a menu parsed off a tmux CLI pane for the task service (design doc
 * §9.8, §11.6). Only a numbered menu with exactly one one-shot allow option
 * and exactly one deny option is a brokerable permission request; anything
 * else needs a human at the terminal (`interaction.required`).
 */
import { createHash } from 'crypto'
import type { Dialog, DialogOption } from '../../tmux/dialog'

export interface PermissionPair {
  allow: DialogOption
  deny: DialogOption
}

const ALLOW_RE = /^\s*(yes|allow|approve|run|proceed|accept|continue)\b/i
/** Wording that turns an allow into a standing grant — never a one-shot allow. */
const STANDING_RE = /\b(always|every|all|session|remember|permanent(ly)?|future|ask again|from now on)\b/i
const DENY_RE = /^\s*(no|deny|reject|cancel|decline|skip|abort)\b/i

/** Stable id for "this exact menu": question plus numbered labels, so a redraw keeps the id. */
export function dialogRequestId(dialog: Dialog): string {
  const text = [dialog.kind, dialog.question, ...dialog.options.map(o => `${o.number}. ${o.label}`)].join('\n')
  return `dlg:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`
}

export function findDenyOption(dialog: Dialog): DialogOption | null {
  if (dialog.kind !== 'numbered') return null
  const denies = dialog.options.filter(o => DENY_RE.test(o.label))
  return denies.length === 1 ? denies[0] : null
}

export function permissionPair(dialog: Dialog): PermissionPair | null {
  if (dialog.kind !== 'numbered') return null
  const allows = dialog.options.filter(o => ALLOW_RE.test(o.label) && !STANDING_RE.test(o.label))
  const deny = findDenyOption(dialog)
  return allows.length === 1 && deny ? { allow: allows[0], deny } : null
}

/** One-line description for the permission record (the engine redacts it again). */
export function describeDialog(dialog: Dialog): string {
  return `${dialog.question} [${dialog.options.map(o => `${o.number}. ${o.label}`).join(' | ')}]`
}
