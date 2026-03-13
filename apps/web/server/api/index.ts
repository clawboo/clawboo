import { Router, type Router as RouterType } from 'express'

import { settingsGET, settingsPOST } from './settings'
import { approvalsGET, approvalsPOST } from './approvals'
import { chatHistoryGET, chatHistoryPOST, chatHistoryDELETE } from './chatHistory'
import { costRecordsGET, costRecordsPOST } from './costRecords'
import { costRecordsSummaryGET } from './costRecordsSummary'
import { graphLayoutGET, graphLayoutPOST } from './graphLayout'
import { ollamaCheckGET } from './ollamaCheck'
import { personalityGET, personalityPOST } from './personality'
import { skillsGET, skillsPOST, skillsDELETE } from './skills'

const router: RouterType = Router()

// Settings
router.get('/api/settings', settingsGET)
router.post('/api/settings', settingsPOST)

// Approvals
router.get('/api/approvals', approvalsGET)
router.post('/api/approvals', approvalsPOST)

// Chat history
router.get('/api/chat-history', chatHistoryGET)
router.post('/api/chat-history', chatHistoryPOST)
router.delete('/api/chat-history', chatHistoryDELETE)

// Cost records — summary must be before the shorter prefix
router.get('/api/cost-records/summary', costRecordsSummaryGET)
router.get('/api/cost-records', costRecordsGET)
router.post('/api/cost-records', costRecordsPOST)

// Graph layout
router.get('/api/graph-layout', graphLayoutGET)
router.post('/api/graph-layout', graphLayoutPOST)

// Ollama check
router.get('/api/ollama-check', ollamaCheckGET)

// Personality
router.get('/api/personality', personalityGET)
router.post('/api/personality', personalityPOST)

// Skills
router.get('/api/skills', skillsGET)
router.post('/api/skills', skillsPOST)
router.delete('/api/skills', skillsDELETE)

export { router as apiRouter }
