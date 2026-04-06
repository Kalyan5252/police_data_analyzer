export const INVESTIGATION_INTENTS = [
  'call_activity',
  'message_activity',
  'video_activity',
  'events_on_date',
  'received_calls_on_date',
  'hidden_link_phone_phone',
  'co_location',
  'events_at_cell',
  'event_location_lookup',
  'phone_to_ip',
  'ip_to_events',
  'phone_to_imei',
  'phone_to_location_path',
  'generic_relationship',
  'flowchart_request',
  'other',
] as const;

export type InvestigationIntent = (typeof INVESTIGATION_INTENTS)[number];

export const INTENT_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type IntentConfidence = (typeof INTENT_CONFIDENCE_LEVELS)[number];

export const INTENT_REASON_TAGS = [
  'wrong-node',
  'wrong-hop',
  'wrong-date',
  'wrong-entity',
  'wrong-strategy',
  'other',
] as const;
export type IntentReasonTag = (typeof INTENT_REASON_TAGS)[number];

export function isInvestigationIntent(value: string): value is InvestigationIntent {
  return (INVESTIGATION_INTENTS as readonly string[]).includes(value);
}

export function isIntentConfidence(value: string): value is IntentConfidence {
  return (INTENT_CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

export function isIntentReasonTag(value: string): value is IntentReasonTag {
  return (INTENT_REASON_TAGS as readonly string[]).includes(value);
}

