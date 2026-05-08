import { Router, type Router as RouterType } from 'express'

import { settingsGET, settingsPOST } from './settings'
import { approvalsGET, approvalsPOST } from './approvals'
import { chatHistoryGET, chatHistoryPOST, chatHistoryDELETE } from './chatHistory'
import { costRecordsGET, costRecordsPOST } from './costRecords'
import { costRecordsSummaryGET } from './costRecordsSummary'
import { graphLayoutGET, graphLayoutPOST } from './graphLayout'
import { ollamaCheckGET } from './ollamaCheck'
import { execSettingsGET, execSettingsAllGET, execSettingsPOST } from './execSettings'
import { personalityGET, personalityPOST } from './personality'
import { skillsGET, skillsPOST, skillsDELETE } from './skills'
import {
  systemStatusGET,
  installOpenclawPOST,
  configureOpenclawPOST,
  gatewayControlPOST,
  openclawConfigGET,
  openclawConfigPATCH,
  systemModelsGET,
} from './system'
import {
  teamsGET,
  teamsPOST,
  teamsPATCH,
  teamsDELETE,
  teamAgentPOST,
  teamAgentDELETE,
} from './teams'
import { teamOnboardingGET, teamOnboardingPATCH } from './teamOnboarding'

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

// Exec settings — /all must come before the shorter prefix
router.get('/api/exec-settings/all', execSettingsAllGET)
router.get('/api/exec-settings', execSettingsGET)
router.post('/api/exec-settings', execSettingsPOST)

// Personality
router.get('/api/personality', personalityGET)
router.post('/api/personality', personalityPOST)

// Skills
router.get('/api/skills', skillsGET)
router.post('/api/skills', skillsPOST)
router.delete('/api/skills', skillsDELETE)

// System management
router.get('/api/system/status', systemStatusGET)
router.post('/api/system/install-openclaw', installOpenclawPOST)
router.post('/api/system/configure-openclaw', configureOpenclawPOST)
router.post('/api/system/gateway', gatewayControlPOST)
router.get('/api/system/openclaw-config', openclawConfigGET)
router.patch('/api/system/openclaw-config', openclawConfigPATCH)
router.get('/api/system/models', systemModelsGET)

// Teams
router.get('/api/teams', teamsGET)
router.post('/api/teams', teamsPOST)
router.patch('/api/teams/:id', teamsPATCH)
router.delete('/api/teams/:id', teamsDELETE)
router.post('/api/teams/:id/agents', teamAgentPOST)
router.delete('/api/teams/:id/agents/:agentId', teamAgentDELETE)

// Team onboarding (per-team boolean flags for "Know Your Team" gate)
router.get('/api/teams/:id/onboarding', teamOnboardingGET)
router.patch('/api/teams/:id/onboarding', teamOnboardingPATCH)

export { router as apiRouter }
