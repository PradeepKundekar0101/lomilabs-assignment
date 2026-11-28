import { QueryClient } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import { ApiError } from './api/client.ts'
import { App } from './App.tsx'
import { Providers } from './Providers.tsx'

// A 4xx (an unknown document, say) answers the same on every retry; only network and server errors are worth retrying.
const retry = (failures: number, err: Error) => !(err instanceof ApiError && err.status < 500) && failures < 3
const client = new QueryClient({ defaultOptions: { queries: { retry } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Providers>
  </StrictMode>,
)
