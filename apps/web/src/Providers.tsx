import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

/** Everything the app needs around it except the router, so tests can bring their own. */
export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {children}
        <Toaster richColors />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
