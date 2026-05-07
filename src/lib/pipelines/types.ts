export type StageStatus =
  | "blocked"
  | "ready"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";
export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "needs-human"
  | "cancelled";

export interface PipelineTrigger {
  type: "kanban_task";
  priority?: number;
  conditions: {
    board?: string;
    assignee?: string;
    body_contains?: string[];
  };
}

export interface PipelineDefaults {
  retry: {
    max_attempts: number;
    on_exhaustion: string;
  };
  timeout: string;
}

export interface StageOnFailure {
  retry_with?: {
    assignee: string;
    body: string;
    max_retries?: number;
  };
  goto?: string;
  inject_feedback?: boolean;
  max_loops?: number;
}

export interface FanOutAgent {
  assignee: string;
  focus: string;
}

export interface StageDefinition {
  id: string;
  name: string;
  assignee?: string;
  agents?: FanOutAgent[];
  type?: "parallel_fan_out";
  depends_on?: string[];
  condition?: string;
  skip_if?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  actions?: Record<string, unknown>[];
  success_criteria?: string[];
  constraints?: string[];
  on_failure?: StageOnFailure;
  fan_in?: "all_pass";
  timeout?: string;
  preconditions?: string[];
}

export interface QualityGate {
  enabled: boolean;
  after_stages: string[];
  model?: string;
  max_rejections?: number;
  on_max_rejections?: string;
}

export interface PipelineMetrics {
  track: string[];
  alerts?: Array<{ condition: string; action: string }>;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  variables: Record<string, string>;
  defaults: PipelineDefaults;
  stages: StageDefinition[];
  quality_gates?: Record<string, QualityGate>;
  metrics?: PipelineMetrics;
}

export interface StageRunState {
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  conversationId?: string;
  conversationIds?: string[]; // for parallel fan-out
  outputs?: Record<string, unknown>;
  retries: number;
  blockedBy?: string[];
  error?: string;
  failureLoop?: number; // tracks goto loops
}

export interface PipelineRun {
  id: string;
  pipeline: string;
  triggerTaskId: string;
  targetRepo: string;
  variables: Record<string, unknown>;
  stages: Record<string, StageRunState>;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  escalationReason?: string;
}
