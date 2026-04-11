// Hand-written — 5 clawboo builtin teams that reference clawboo-* catalog IDs.
// Source: apps/web/src/features/marketplace/agents/clawboo/sources/*.ts
//
// Agent ID convention: `clawboo-<teamId>-<slugify(agentName)>` matching
// `CLAWBOO_BUILTIN_AGENTS` in `agents/clawboo/builtin.ts`. Routing preserves
// the original @mention content from the source TeamTemplate literals.
//
// Update if the source template files are renamed or restructured.

import type { TeamTemplate } from '@/features/teams/types'

export const CLAWBOO_BUILTIN_TEAMS: TeamTemplate[] = [
  {
    id: 'dev',
    name: 'Dev Team',
    emoji: '👾',
    color: '#34D399',
    description:
      'Code review, bug hunting, and documentation — a tight engineering trio that keeps the codebase clean.',
    category: 'engineering',
    source: 'clawboo',
    tags: ['code review', 'debugging', 'documentation', 'engineering', 'testing', 'development'],
    agentIds: [
      'clawboo-dev-code-reviewer-boo',
      'clawboo-dev-bug-fixer-boo',
      'clawboo-dev-doc-writer-boo',
    ],
    routing: {
      'clawboo-dev-code-reviewer-boo':
        '# AGENTS\n\nWhen a review uncovers a bug that needs investigation, route to @Bug Fixer Boo for root cause analysis and fix.\nWhen a review reveals undocumented behaviour, coordinate with @Doc Writer Boo to update the docs.',
      'clawboo-dev-bug-fixer-boo':
        '# AGENTS\n\nWhen a fix is ready for review, route to @Code Reviewer Boo for a thorough code review.\nWhen a fix changes behaviour that users rely on, coordinate with @Doc Writer Boo to update documentation.',
      'clawboo-dev-doc-writer-boo':
        '# AGENTS\n\nWhen you need technical details about a code change, route to @Code Reviewer Boo for context on recent reviews.\nWhen documenting a bug fix, coordinate with @Bug Fixer Boo for the root cause analysis and fix details.',
    },
  },
  {
    id: 'marketing',
    name: 'Marketing Squad',
    emoji: '📣',
    color: '#E94560',
    description:
      'Content creation, SEO, and social media — a coordinated marketing team ready to amplify your message.',
    category: 'marketing',
    source: 'clawboo',
    tags: ['content', 'seo', 'social media', 'copywriting', 'campaigns', 'marketing'],
    agentIds: [
      'clawboo-marketing-content-writer-boo',
      'clawboo-marketing-seo-analyst-boo',
      'clawboo-marketing-social-media-manager-boo',
    ],
    routing: {
      'clawboo-marketing-content-writer-boo':
        '# AGENTS\n\nWhen content needs SEO optimization, route to @SEO Analyst Boo for keyword research and on-page guidance.\nWhen content is ready to distribute, coordinate with @Social Media Manager Boo for platform-specific adaptations.',
      'clawboo-marketing-seo-analyst-boo':
        '# AGENTS\n\nWhen new content is needed for a keyword opportunity, route to @Content Writer Boo with the keyword brief.\nWhen optimized content is ready to publish, coordinate with @Social Media Manager Boo for launch amplification.',
      'clawboo-marketing-social-media-manager-boo':
        '# AGENTS\n\nWhen you need long-form content to adapt, route to @Content Writer Boo with the platform requirements.\nWhen planning campaigns around trending keywords, coordinate with @SEO Analyst Boo for keyword insights.',
    },
  },
  {
    id: 'research',
    name: 'Research Lab',
    emoji: '🔬',
    color: '#A78BFA',
    description:
      'Paper analysis, data synthesis, and summarization — a focused research team for academic and technical deep dives.',
    category: 'research',
    source: 'clawboo',
    tags: ['research', 'analysis', 'papers', 'data', 'synthesis', 'academic'],
    agentIds: [
      'clawboo-research-paper-reader-boo',
      'clawboo-research-data-analyst-boo',
      'clawboo-research-summarizer-boo',
    ],
    routing: {
      'clawboo-research-paper-reader-boo':
        '# AGENTS\n\nWhen a paper includes statistical results that need deeper analysis, route to @Data Analyst Boo for quantitative review.\nWhen a paper is fully processed and ready for a final brief, coordinate with @Summarizer Boo for the executive summary.',
      'clawboo-research-data-analyst-boo':
        "# AGENTS\n\nWhen you need context on a paper's methodology or findings, route to @Paper Reader Boo for literature analysis.\nWhen analysis is complete and needs to be distilled for stakeholders, coordinate with @Summarizer Boo for the final writeup.",
      'clawboo-research-summarizer-boo':
        '# AGENTS\n\nWhen you need the full context of a paper before summarizing, route to @Paper Reader Boo for detailed analysis.\nWhen you need quantitative findings interpreted, coordinate with @Data Analyst Boo for statistical context.',
    },
  },
  {
    id: 'student',
    name: 'Student Pack',
    emoji: '📚',
    color: '#38BDF8',
    description:
      'Study help, essay feedback, and flashcards — a friendly learning crew that makes studying less painful.',
    category: 'education',
    source: 'clawboo',
    tags: ['study', 'essays', 'flashcards', 'learning', 'academic', 'education'],
    agentIds: [
      'clawboo-student-study-buddy-boo',
      'clawboo-student-essay-helper-boo',
      'clawboo-student-flashcard-maker-boo',
    ],
    routing: {
      'clawboo-student-study-buddy-boo':
        '# AGENTS\n\nWhen a student needs help structuring an essay or paper, route to @Essay Helper Boo for writing guidance.\nWhen a student wants to drill specific facts or concepts, coordinate with @Flashcard Maker Boo for spaced-repetition cards.',
      'clawboo-student-essay-helper-boo':
        '# AGENTS\n\nWhen a student needs help understanding the source material before writing, route to @Study Buddy Boo for concept explanations.\nWhen an essay covers testable facts, coordinate with @Flashcard Maker Boo to build review cards.',
      'clawboo-student-flashcard-maker-boo':
        '# AGENTS\n\nWhen you need a concept explained before turning it into cards, route to @Study Buddy Boo for a plain-English breakdown.\nWhen source material comes from an essay or paper, coordinate with @Essay Helper Boo for the key terms list.',
    },
  },
  {
    id: 'youtube',
    name: 'YouTube Crew',
    emoji: '🎬',
    color: '#FBBF24',
    description:
      'Script writing, thumbnail direction, and SEO — a content creator crew ready to help you ship videos that perform.',
    category: 'content',
    source: 'clawboo',
    tags: ['youtube', 'video', 'scripts', 'thumbnails', 'seo', 'creator'],
    agentIds: [
      'clawboo-youtube-script-writer-boo',
      'clawboo-youtube-thumbnail-advisor-boo',
      'clawboo-youtube-seo-optimizer-boo',
    ],
    routing: {
      'clawboo-youtube-script-writer-boo':
        '# AGENTS\n\nWhen a script is finalized and needs a thumbnail concept, route to @Thumbnail Advisor Boo for visual direction.\nWhen a script is ready for publishing, coordinate with @SEO Optimizer Boo for the title, description, and tags.',
      'clawboo-youtube-thumbnail-advisor-boo':
        '# AGENTS\n\nWhen you need the hook or payoff from the video to design a thumbnail, route to @Script Writer Boo for the core story beats.\nWhen a thumbnail needs to match the target keyword, coordinate with @SEO Optimizer Boo for keyword placement.',
      'clawboo-youtube-seo-optimizer-boo':
        "# AGENTS\n\nWhen you need the video's core value prop for metadata, route to @Script Writer Boo for the one-sentence hook.\nWhen you need a thumbnail that matches the target keyword, coordinate with @Thumbnail Advisor Boo for visual alignment.",
    },
  },
]
