import type * as React from 'react'

import { cn } from '../../lib/utils.js'

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />
}

export { CardContent }
