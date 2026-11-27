import { useEffect, useState } from 'react'

type Counts = Record<string, number>
export type Health = { db: string; redis: string; versions: Counts | null; queue: Counts | null }

function Counts({ title, counts }: { title: string; counts: Counts | null }) {
  // A service that is down already shows "error" above; there is nothing to count.
  if (!counts) return null
  return (
    <>
      <h2>{title}</h2>
      <dl>
        {Object.entries(counts).map(([name, n]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

export function HealthView({ health, error }: { health?: Health; error?: string }) {
  return (
    <main>
      <h1>System health</h1>
      {error ? (
        <p className="error">Could not reach the API: {error}</p>
      ) : !health ? (
        <p>Checking...</p>
      ) : (
        <>
          <dl>
            {(['db', 'redis'] as const).map((name) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd className={health[name] === 'ok' ? 'ok' : 'error'}>{health[name]}</dd>
              </div>
            ))}
          </dl>
          <Counts title="Queue" counts={health.queue} />
          <Counts title="Versions" counts={health.versions} />
        </>
      )}
    </main>
  )
}

export default function App() {
  const [health, setHealth] = useState<Health>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    // A 503 still carries the per-service body, so read JSON regardless of status.
    fetch('/health')
      .then((res) => res.json())
      .then(setHealth, (err: Error) => setError(err.message))
  }, [])

  return <HealthView health={health} error={error} />
}
