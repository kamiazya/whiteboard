import { type PluginValue, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { TASK_CYCLE_EVENT, taskCycleAnnouncement } from './line-prefix.js'

/**
 * Says what a task cycle did — "Task checked", "Task unchecked", "Task
 * removed" — through a polite status region the editor carries. Ticking a
 * task from the keyboard changes one character, which nothing reads out,
 * while ticking the same box in the preview is announced.
 *
 * The region is created with the view and empty, so it is in the
 * accessibility tree before it ever speaks. A live region speaks a CHANGE of
 * text, so a repeated message alternates a trailing no-break space: ticking
 * two tasks in a row announces both.
 */
class TaskAnnouncer implements PluginValue {
  private readonly region: HTMLElement

  constructor(view: { readonly dom: HTMLElement }) {
    this.region = document.createElement('span')
    this.region.setAttribute('role', 'status')
    this.region.setAttribute('aria-live', 'polite')
    this.region.setAttribute('data-testid', 'source-task-announcement')
    this.region.className = 'sr-only'
    view.dom.appendChild(this.region)
  }

  update(update: ViewUpdate): void {
    if (!update.transactions.some((tr) => tr.isUserEvent(TASK_CYCLE_EVENT))) return
    const text = taskCycleAnnouncement(update.state)
    const previous = this.region.textContent ?? ''
    this.region.textContent = previous === text ? `${text} ` : text
  }

  destroy(): void {
    this.region.remove()
  }
}

export const taskAnnouncer = ViewPlugin.fromClass(TaskAnnouncer)
