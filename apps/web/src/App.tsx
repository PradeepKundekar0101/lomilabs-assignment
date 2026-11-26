import { useEffect, useState } from 'react'

type Health = Record<string, string>

export function HealthView({ health, error }: { health?: Health; error?: string }) {
  return (
    <main>
      <h1>System health</h1>
      {error ? (
        <p className="error">Could not reach the API: {error}</p>
      ) : !health ? (
        <p>Checking...</p>
      ) : (
        <dl>
          {Object.entries(health).map(([name, status]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd className={status === 'ok' ? 'ok' : 'error'}>{status}</dd>
            </div>
          ))}
        </dl>
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
