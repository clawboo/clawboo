// A task's readable id (RES-12), as a person would quote it. The same mark wherever a
// task is listed, so a name on a list can be found on the board. A row with no id shows
// nothing.

export function TaskIdentifier({
  task,
  testId,
}: {
  task: { identifier?: unknown }
  testId: string
}) {
  if (typeof task.identifier !== 'string' || !task.identifier) return null
  return (
    <span
      data-testid={testId}
      className="shrink-0 font-mono text-micro tabular-nums text-muted-foreground"
    >
      {task.identifier}
    </span>
  )
}
