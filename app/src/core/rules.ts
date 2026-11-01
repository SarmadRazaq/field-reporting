import { LIMITS, type LocalReport } from './types';

export type DraftIssue = 'description_required' | 'description_too_long' | 'no_photos' | 'too_many_photos' | 'photo_problem';

/** Why a draft can't be submitted yet, in the order the user should fix them. */
export function draftIssues(draft: Pick<LocalReport, 'description' | 'images'>): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (draft.images.length < LIMITS.minImages) issues.push('no_photos');
  if (draft.images.length > LIMITS.maxImages) issues.push('too_many_photos');
  if (draft.images.some(i => i.problem)) issues.push('photo_problem');
  if (draft.description.trim().length === 0) issues.push('description_required');
  if (draft.description.length > LIMITS.maxDescriptionChars) issues.push('description_too_long');
  return issues;
}

export function photoSlotsLeft(draft: Pick<LocalReport, 'images'>): number {
  return Math.max(0, LIMITS.maxImages - draft.images.length);
}
