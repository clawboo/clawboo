/**
 * Homepage FAQ, shared by the visible <Faq> section and the FAQPage JSON-LD in
 * BaseLayout. Single source of truth so the structured data can never drift from
 * the rendered copy. Copy law: no em dashes.
 *
 * Cut from 11 items to 6 and from ~560 words to ~200. Every dropped question
 * either duplicated a section on the page or duplicated another answer:
 *  - "Do I need OpenClaw" folded into the runtimes answer
 *  - "How is this different" is now the Runtimes section's own subhead
 *  - "Is it production-ready" and "What is not in yet" merged into one
 *
 * Claims verified against the code, not against the previous copy:
 *  - Node floor is 22.12, not 22 (apps/cli/src/node-version.ts:14-15)
 *  - Hermes additionally needs Python 3.11-3.13 + pipx (descriptor.ts:114-119)
 *  - Catalogue counts are deliberately not quoted: PR #184 makes the catalogue a
 *    live fetch (catalogIndex.ts:59-60), so any number here could be
 *    contradicted by the user's own screen.
 */

export interface FaqItem {
  q: string
  a: string
}

export const faqs: FaqItem[] = [
  {
    q: 'Is Clawboo free and open-source?',
    a: 'Yes, MIT licensed and free to use or fork. The code is on GitHub and the package is on npm.',
  },
  {
    q: 'Which agents can I use?',
    a: 'The built-in Native runtime speaks to eleven providers, and a key from any one of them is enough to start. Nothing else needs installing. Claude Code, Codex, Hermes and OpenClaw connect as optional peers.',
  },
  {
    q: 'Where does my data go?',
    a: 'Your board, chat and memory stay on your machine. Prompts and code go only to the model provider you configure. Clawboo itself has no account and no product analytics.',
  },
  {
    q: 'How do agents avoid stepping on each other?',
    a: 'Each task is claimed by a single conditional write, so two agents can never take the same one, and each works in its own copy of the repo.',
  },
  {
    q: 'What do I need to run it?',
    a: 'Node.js 22.12 or newer, on macOS, Linux or Windows. Connecting Hermes also needs Python 3.11 to 3.13 and pipx.',
  },
  {
    q: 'Is it ready for real work?',
    a: 'It is early and moves fast. The board, chat, runtimes, memory and verification gate all ship and are covered by end-to-end tests. Expect rough edges at the margins.',
  },
]
