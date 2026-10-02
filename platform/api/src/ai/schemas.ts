// JSON Schemas used for structured model output. Kept to the portable subset (types, enums, required,
// additionalProperties:false); numeric ranges and cross-field rules are enforced by quality.ts, not trusted to the model.
const str = { type: 'string' } as const;
const strs = { type: 'array', items: str } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const CURRICULUM_SCHEMA = obj({
  title: str,
  outcomes: strs,
  assumptions: strs,
  modules: { type: 'array', items: obj({
    title: str,
    topics: { type: 'array', items: obj({
      title: str, hours: { type: 'integer' }, outcomes: strs, prerequisites: strs, mandatory: { type: 'boolean' },
      lesson_plan: str, assessment_notes: str,
    }) },
  }) },
});

const SCENE_TYPES = ['avatar', 'narration_slides', 'animation', 'screen_demo', 'mixed'];
const IX_KINDS = ['pause_quiz', 'hotspot', 'reflection', 'choose_path', 'tutor_prompt', 'glossary'];

export const TOPIC_CONTENT_SCHEMA = obj({
  scenes: { type: 'array', items: obj({
    id: str, type: { type: 'string', enum: SCENE_TYPES }, narration_en: str, on_screen_text: str, audio_description: str,
    visual_prompt: str, duration_sec: { type: 'number' }, sources: strs,
    interactions: { type: 'array', items: obj({
      kind: { type: 'string', enum: IX_KINDS }, at_sec: { type: 'number' }, prompt: str,
      options: strs, branch_targets: strs, // branch_targets[i] = scene id for options[i], '' if none
    }) },
  }) },
  glossary: { type: 'array', items: obj({ term: str, note: str }) },
  quiz: { type: 'array', items: obj({
    type: { type: 'string', enum: ['MCQ_SINGLE', 'MCQ_MULTI', 'NUMERIC'] }, text: str, options: strs,
    answer_indexes: { type: 'array', items: { type: 'integer' } }, answer_number: { type: 'number' }, tolerance: { type: 'number' },
    points: { type: 'integer' }, rationale: str, outcome: str,
  }) },
  assignment: obj({ instructions: str, rubric: { type: 'array', items: obj({ criterion: str, weight: { type: 'integer' }, description: str }) } }),
});

export const TRANSLATION_SCHEMA = obj({
  scenes: { type: 'array', items: obj({ id: str, narration_hi: str, on_screen_text_hi: str, audio_description_hi: str, interaction_prompts_hi: strs }) },
  quiz: { type: 'array', items: obj({ text_hi: str, options_hi: strs, rationale_hi: str }) },
  assignment_instructions_hi: str,
});

export const JUDGE_CONTENT_SCHEMA = obj({
  unsupported_claims: { type: 'array', items: obj({ scene_id: str, claim: str, reason: str }) },
  factual_inconsistencies: { type: 'array', items: obj({ scene_id: str, issue: str }) },
  safety_findings: { type: 'array', items: obj({ scene_id: str, issue: str }) },
  bias_findings: { type: 'array', items: obj({ scene_id: str, issue: str }) },
});

export const JUDGE_TRANSLATION_SCHEMA = obj({
  scores: { type: 'array', items: obj({ scene_id: str, score: { type: 'integer' }, issue: str }) }, // 1 (wrong) .. 5 (faithful, natural)
});

export const TUTOR_SCHEMA = obj({
  answer: str, used_source_ids: strs, confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, needs_teacher: { type: 'boolean' },
});

export const GRADING_SCHEMA = obj({
  dimensions: { type: 'array', items: obj({
    id: str, score: { type: 'number' }, rationale: str, confidence: { type: 'number' },
    evidence: { type: 'array', items: obj({ quote: str, location: str }) },
  }) },
  overall_feedback: str, overall_confidence: { type: 'number' }, flags: strs,
});

export const SCHEMAS: Record<string, object> = {
  curriculum: CURRICULUM_SCHEMA, topic_content: TOPIC_CONTENT_SCHEMA, translation: TRANSLATION_SCHEMA,
  judge_content: JUDGE_CONTENT_SCHEMA, tutor: TUTOR_SCHEMA, grading: GRADING_SCHEMA, judge_translation: JUDGE_TRANSLATION_SCHEMA,
};
