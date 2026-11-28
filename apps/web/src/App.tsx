import { Link, Route, Routes } from 'react-router'
import sky from '@/assets/pastel-cloud-glow.webp'
import { DocumentListPage } from '@/pages/DocumentListPage'
import { DocumentPage } from '@/pages/DocumentPage'

export function App() {
  return (
    <div className="relative isolate min-h-screen">
      {/* BG 005 "Pastel Cloud Glow", Super Visuals: Backgrounds Library (Figma Community), fading into the page wash (spec 012). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[30rem] bg-cover bg-center mask-b-from-40%"
        style={{ backgroundImage: `url(${sky})` }}
      />
      <header className="on-sky">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-7">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-primary">
            <span className="size-2.5 rounded-full bg-brand ring-2 ring-white/80" aria-hidden />
            Lomi
            <span className="font-normal text-muted-foreground">Review</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-7 sm:pt-12">
        <Routes>
          <Route path="/" element={<DocumentListPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
        </Routes>
      </main>
    </div>
  )
}
