// A brief, premium "just installed" acknowledgement — a mint-washed chip with a
// check badge that confirms an install SUCCEEDED before (and above) the next
// step's connect / sign-in affordance. Without it, the row jumps straight from
// the "Installing…" spinner to the sign-in state with no moment of "it worked".
//
// It is set ONLY by an install's own completion handler (never on a render of an
// already-installed-but-unconnected runtime), and it naturally clears once the
// runtime reaches its connected state (the card swaps to the connected view).

import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

export function InstalledAck({ name, testId }: { name: string; testId?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
      className="flex items-center gap-2 rounded-lg px-3 py-2"
      style={{ background: 'rgb(var(--mint-rgb) / 0.1)' }}
      data-testid={testId}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--mint)', color: 'var(--background)' }}
      >
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="text-[12px] font-medium text-foreground">{name} installed</span>
      <span className="text-[11.5px]" style={{ color: 'rgb(var(--foreground-rgb) / 0.5)' }}>
        · now connect it below
      </span>
    </motion.div>
  )
}
