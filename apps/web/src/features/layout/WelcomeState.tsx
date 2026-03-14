export function WelcomeState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
        textAlign: 'center',
        padding: 32,
      }}
    >
      <img src="/logo.svg" alt="Clawboo" width={64} height={59} style={{ opacity: 0.25 }} />
      <div>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: 'rgba(232,232,232,0.75)',
            margin: 0,
            fontFamily: 'var(--font-display)',
          }}
        >
          Welcome to Clawboo
        </h2>
        <p
          style={{
            fontSize: 13,
            color: 'rgba(232,232,232,0.35)',
            margin: '6px 0 0',
          }}
        >
          Select an agent to start chatting, or explore the dashboard.
        </p>
      </div>
    </div>
  )
}
