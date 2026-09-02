// Who wrote this, under what licence, taken at which commit.
//
// Shown on both detail sheets. The catalog demands a licence from every pack and
// used to discard it before the user saw anything, which meant the marketplace
// could not answer the first question a person should ask about content that is
// about to become an agent's instructions: whose work is this?
//
// Deliberately factual. No "safe", "verified", "vetted" or "approved" anywhere:
// Clawboo checks the licence, pins the commit and scans for known injection
// patterns, but it does not audit behaviour, and a badge implying otherwise
// would be the dishonest part.

import { ExternalLink } from 'lucide-react'

import type { CatalogProvenance } from './catalogTypes'
import { attributionLine, repoLabel, shortRef } from './provenance'

const LABEL = 'font-mono text-[10px] uppercase tracking-[0.04em] text-muted-foreground'

export function ProvenanceNote({ provenance }: { provenance: CatalogProvenance | undefined }) {
  if (!provenance) return null
  const repo = repoLabel(provenance.repo)
  const ref = shortRef(provenance.ref)
  const attribution = attributionLine(provenance)

  return (
    <div className="mb-4">
      <div className={`mb-2 ${LABEL}`}>Where this came from</div>
      <div className="rounded-xl border border-border bg-foreground/[0.02] px-3 py-2.5">
        {attribution && (
          <div className="text-[12px] leading-relaxed text-foreground/70">{attribution}</div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          {provenance.repo && repo && (
            <a
              href={provenance.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="text-mint/80 no-underline transition-colors hover:text-mint"
            >
              {repo}
              <ExternalLink size={10} className="ml-0.5 inline" strokeWidth={2} />
            </a>
          )}
          {ref && (
            <span>
              pinned at <span className="font-mono">{ref}</span>
            </span>
          )}
          <span>{provenance.license}</span>
        </div>
      </div>
    </div>
  )
}
