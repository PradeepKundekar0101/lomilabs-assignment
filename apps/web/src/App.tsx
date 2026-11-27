import { Link, Route, Routes } from 'react-router'
import { DocumentListPage } from '@/pages/DocumentListPage'
import { DocumentPage } from '@/pages/DocumentPage'

export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <Link to="/" className="font-semibold">
            Lomi review
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<DocumentListPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
        </Routes>
      </main>
    </div>
  )
}
