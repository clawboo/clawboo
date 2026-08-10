// The schema as it stood when the additive reconciler was reviewed.
//
// This exists for ONE assertion, in schemaReconcile.test.ts: any column added to a
// table that was ALREADY here must be one SQLite can `ALTER TABLE ... ADD COLUMN`
// into a database that already has rows. Without it that mistake is invisible in CI
// (the addability gate only fires against a database that is MISSING the column,
// and no fresh-install test database ever is), so the first sign of it would be
// every upgrading user's boot failing.
//
// 133 of the columns below are NOT addable (26 PRIMARY KEY, 107 NOT NULL with no
// DEFAULT). That is fine, and it is why the assertion is scoped to what is NEW: a
// column present at CREATE TABLE time never has to be added to anything.
//
// It needs no upkeep. A column added after this snapshot simply reads as new and is
// held to the addability rule, which is the rule anyway, so leaving this file alone
// is the correct default. Re-snapshot it only to record a deliberate exception, and
// never to make a failing test pass: that failure is telling you the column cannot
// reach a database that already exists.
//
// Stored as space-separated names rather than arrays purely for size.

export const SCHEMA_BASELINE: Record<string, string> = {
  teams:
    'id name icon color color_collection_id template_id leader_agent_id is_archived tenant_id created_at updated_at',
  agents:
    'id name gateway_id avatar_seed personality_config exec_config team_id status source_id source_agent_id identity_json participant_kind runtime capabilities tenant_id archived_at created_at updated_at',
  sessions:
    'id source_id source_session_id agent_id team_id status parent_session_id runtime tenant_id created_at updated_at',
  cost_records: 'id agent_id model input_tokens output_tokens cost_usd run_id created_at',
  graph_layouts: 'id name gateway_url layout_data created_at updated_at',
  settings: 'key value updated_at',
  skills: 'id name source category trust_score installed_at metadata',
  team_profiles:
    'id name description agents_config skills_config graph_layout is_builtin created_at',
  approval_history: 'id agent_id action tool_name details created_at',
  chat_messages: 'id session_key gateway_url entry_id timestamp_ms data',
  boo_zero_team_briefs: 'team_id content updated_at',
  tasks:
    'id title description status priority team_id assignee_agent_id assignee_runtime parent_task_id source_delegation_id worktree_ref branch_ref cost_usd parent_session_id dropped tenant_id verification scheduled_by created_at updated_at completed_at',
  task_deps: 'task_id depends_on_task_id tenant_id',
  task_comments: 'id task_id author_agent_id author_type body tenant_id created_at',
  workspaces: 'id task_id repo_path branch worktree_path status tenant_id created_at last_used_at',
  execution_processes:
    'id task_id workspace_id executor_type status claimed_at started_at completed_at before_commit after_commit input_tokens output_tokens cache_read cache_write cost_usd summary run_reason error recovery_tombstone tenant_id created_at',
  scheduled_runs:
    'id agent_id team_id cron_spec task_template status last_run_at next_run_at scheduled_by last_error tenant_id created_at updated_at',
  memory_facts:
    'id title content tags embedding embedding_model scope_agent_id scope_team_id tenant_id created_at updated_at',
  memory_procedures: 'id name version content scope_agent_id scope_team_id tenant_id created_at',
  tool_registry:
    'name description input_schema availability owner provenance_signer_id provenance_signature provenance_signed_at enabled created_at updated_at',
  tool_call_audit:
    'id tool_name agent_id phase decision args_summary result_summary is_error tenant_id created_at',
  tool_call_approvals:
    'id tool_name agent_id args_summary reason status task_id tenant_id created_at expires_at resolved_at',
  budgets:
    'id scope scope_id limit_usd_cents spent_usd_cents spent_micro_cents status mode tenant_id created_at updated_at',
  governance_audit: 'id event_type agent_id task_id team_id tenant_id summary created_at',
  orchestration_events:
    'seq id ts kind team_id task_id agent_id runtime trace_id span_id parent_span_id correlation_id data tenant_id created_at',
  capabilities:
    'id source_id source_key kind runtime scope agent_id origin manageability name description availability available diagnostics provenance status tenant_id synced_at created_at updated_at',
  team_chat: 'id room_id team_id author_agent_id body kind created_at seq',
}
