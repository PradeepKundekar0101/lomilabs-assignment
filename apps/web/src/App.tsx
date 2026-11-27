import { Link, Route, Routes } from 'react-router'
import { DocumentListPage } from '@/pages/DocumentListPage'
import { DocumentPage } from '@/pages/DocumentPage'

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-7">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-primary">
            <span className="size-2.5 rounded-full bg-brand" aria-hidden />
            Lomi
            <span className="font-normal text-muted-foreground">Review</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-7">
        <Routes>
          <Route path="/" element={<DocumentListPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
        </Routes>
      </main>
    </div>
  )
}
