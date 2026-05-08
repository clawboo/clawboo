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
        '# AGENTS\n\nWhen a review uncovers a bug that needs investigation:\n  @Bug Fixer Boo, please investigate the root cause and fix it.\nWhen a review reveals undocumented behaviour:\n  @Doc Writer Boo, please update the docs to cover this behaviour.',
      'clawboo-dev-bug-fixer-boo':
        '# AGENTS\n\nWhen a fix is ready for review:\n  @Code Reviewer Boo, please review this fix thoroughly.\nWhen a fix changes behaviour that users rely on:\n  @Doc Writer Boo, please update the documentation to reflect this change.',
      'clawboo-dev-doc-writer-boo':
        '# AGENTS\n\nWhen you need technical details about a code change:\n  @Code Reviewer Boo, please provide context on the recent reviews.\nWhen documenting a bug fix:\n  @Bug Fixer Boo, please share the root cause analysis and fix details.',
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
        '# AGENTS\n\nWhen you need keyword research or SEO guidance for a piece:\n  @SEO Analyst Boo, please provide optimization recommendations.\nWhen content is ready for distribution:\n  @Social Media Manager Boo, please create platform-specific adaptations.',
      'clawboo-marketing-seo-analyst-boo':
        '# AGENTS\n\nWhen you have keyword recommendations or content briefs ready:\n  @Content Writer Boo, please draft the content based on these keywords.\nWhen optimising for social discovery:\n  @Social Media Manager Boo, please align keywords across platforms.',
      'clawboo-marketing-social-media-manager-boo':
        '# AGENTS\n\nWhen you need long-form content to repurpose into social posts:\n  @Content Writer Boo, please draft the content for repurposing.\nWhen you need keyword data or trending topic research:\n  @SEO Analyst Boo, please provide search insights and trending data.',
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
        '# AGENTS\n\nWhen you have extracted data or statistics that need deeper analysis:\n  @Data Analyst Boo, please review these numbers quantitatively.\nWhen reading notes are complete and ready for distillation:\n  @Summarizer Boo, please synthesize these notes into a summary.',
      'clawboo-research-data-analyst-boo':
        '# AGENTS\n\nWhen you need context on the source or methodology behind a dataset:\n  @Paper Reader Boo, please provide the original study details.\nWhen analysis is complete and ready for the final report:\n  @Summarizer Boo, please write the executive summary.',
      'clawboo-research-summarizer-boo':
        '# AGENTS\n\nWhen you need deeper reading notes or source verification:\n  @Paper Reader Boo, please extract the details from the source.\nWhen you need data-backed claims or statistical validation:\n  @Data Analyst Boo, please provide quantitative support for these claims.',
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
        "# AGENTS\n\nWhen a student needs help structuring an essay based on what they've studied:\n  @Essay Helper Boo, please help them outline and structure the essay.\nWhen study material needs to be converted into review cards:\n  @Flashcard Maker Boo, please create review cards from this material.",
      'clawboo-student-essay-helper-boo':
        '# AGENTS\n\nWhen the student needs to understand a concept before writing about it:\n  @Study Buddy Boo, please explain this concept and provide context.\nWhen the essay requires memorisation of key terms or dates:\n  @Flashcard Maker Boo, please create review cards for these terms.',
      'clawboo-student-flashcard-maker-boo':
        '# AGENTS\n\nWhen you need a concept explained before creating cards for it:\n  @Study Buddy Boo, please provide a clear breakdown of this concept.\nWhen flashcards relate to essay topics:\n  @Essay Helper Boo, please share the key arguments and evidence to include.',
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
        '# AGENTS\n\nWhen a script is drafted:\n  @Thumbnail Advisor Boo, please align the thumbnail visuals with the script content.\nWhen finalising a script:\n  @SEO Optimizer Boo, please provide keyword-optimised titles and description.',
      'clawboo-youtube-thumbnail-advisor-boo':
        "# AGENTS\n\nWhen you need context on the video's content to align the thumbnail:\n  @Script Writer Boo, please share the script and key moments.\nWhen optimising thumbnail text for search:\n  @SEO Optimizer Boo, please provide high-performing keywords.",
      'clawboo-youtube-seo-optimizer-boo':
        '# AGENTS\n\nWhen you need the script content for keyword extraction:\n  @Script Writer Boo, please share the full script.\nWhen optimising click-through rate:\n  @Thumbnail Advisor Boo, please review thumbnail-title alignment.',
    },
  },
]
