import { type LayoutRefusal, refusalCopy } from '@kamiazya/whiteboard-canvas-render'
import { cn } from '../../lib/utils.js'

/**
 * A refusal said in HTML, for a surface whose picture could not draw it (see
 * `undrawnRefusal`): the same words `refusalCopy` gives every notice.
 */
export function RefusalWords({
  refusal,
  className,
}: {
  readonly refusal: LayoutRefusal
  readonly className?: string
}) {
  const { title, detail } = refusalCopy(refusal)
  return (
    <div role="status" data-testid="refusal-words" className={cn('text-sm', className)}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  )
}
