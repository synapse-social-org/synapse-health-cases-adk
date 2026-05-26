'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BorderBeam } from 'border-beam';
import { motion, useReducedMotion } from 'framer-motion';
import { useQueryState } from 'nuqs';
import z from 'zod';
import AnimatedDots from '@/app/components/AnimatedDots';
import Button from '@/app/components/Button';
import LoadingSpinner from '@/app/components/LoadingSpinner';
import SynapseIcon from '@/app/components/icons/SynapseIcon';
import { feedPhraseToId, UserDataSchema } from '@synapse/lib';
import {
  HealthCase,
  HealthCaseClinicalTrial,
  HealthCaseFeedSuggestion,
  HealthCaseIntake,
  HealthCaseProfile,
  HealthCaseResearcher,
  useCreateHealthCase,
  useDeleteHealthCase,
  useGenerateHealthCaseBrief,
  useHealthCase,
  useHealthCaseIntake,
  useHealthCases,
  useRequestHealthCaseResearcherContact,
  useUpdateHealthCaseProfile,
  useUploadHealthCaseDocument,
} from '@/app/hooks/useHealthCases';
import { parseBrief, safeFilename } from './briefPdf';
import { MarkdownContent } from '@/app/components/markdown/MarkdownContent';
import { authFetch } from '@/lib/authUtils';
import { safeHref } from '@/lib/safeHref';

const emptyProfile: HealthCaseProfile = {
  conditions: [],
  symptoms: [],
  medications: [],
  procedures: [],
  labs: [],
  timeline: [],
  goals: [],
  location_preferences: {},
  questions: [],
  notes: '',
};

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinLines(values?: string[]): string {
  return (values || []).join('\n');
}

function deriveCaseTitle(story: string): string {
  const normalized = story.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New Health Case';
  const firstSentence = normalized.split(/[.!?]/)[0]?.trim() || normalized;
  return firstSentence.length > 76 ? `${firstSentence.slice(0, 73).trimEnd()}...` : firstSentence;
}

function deriveConditionTerms(story: string): string[] {
  const lower = story.toLowerCase();
  const candidates = [
    'atrial fibrillation',
    'heart failure',
    'hfpef',
    'hfref',
    'coronary artery disease',
    'hypertension',
    'aortic stenosis',
    'cardiomyopathy',
    'high cholesterol',
    'chest pain',
    'palpitations',
  ];
  return candidates.filter((term) => lower.includes(term)).slice(0, 5);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isAffirmative(text: string): boolean {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,]+$/, '');
  if (!value) return false;
  return [
    'y',
    'yes',
    'yep',
    'yeah',
    'sure',
    'go',
    'go for it',
    'do it',
    'continue',
    "let's go",
    'lets go',
    'generate',
    'generate it',
    'looks good',
    'looks right',
    'sounds good',
    'okay',
    'ok',
    'proceed',
    'ready',
    "i'm ready",
    'im ready',
  ].includes(value);
}

const briefSections = [
  {
    id: 'experts',
    heading: '## 1. What Experts Are Saying',
    title: 'What Experts Are Saying',
    description: 'Knowledge graph, evidence graph, guidelines, editorials, X/web discourse.',
  },
  {
    id: 'papers',
    heading: '## 2. Relevant Research Papers',
    title: 'Relevant Research Papers',
    description: 'Cited papers plus a feed topic to keep tracking this case.',
    cta: 'Create Feed',
  },
  {
    id: 'researchers',
    heading: '## 3. Relevant Researchers',
    title: 'Relevant Researchers',
    description: 'Researchers, trialists, and centers with a rationale for outreach.',
    cta: 'Request Contact',
  },
  {
    id: 'trials',
    heading: '## 4. Clinical Trials',
    title: 'Clinical Trials',
    description: 'Relevant trials, status, eligibility caveats, and NCT IDs when available.',
  },
  {
    id: 'topics',
    heading: '## 5. Topics to Discuss With Your Specialist',
    title: 'Topics to Discuss With Your Specialist',
    description:
      'Citation-grounded conversation topics to raise with your clinical team. Not medical advice.',
  },
  {
    id: 'feedback',
    heading: '## 6. Feedback',
    // Legacy briefs (saved before the Topics section was added) used "## 5.
    // Feedback". Fall back to that so previously-generated briefs still render
    // their Feedback content.
    legacyHeadings: ['## 5. Feedback'],
    title: 'Feedback',
    description: 'Refine the brief, add missing context, or flag anything that looks off.',
    cta: 'Give Feedback',
  },
];

function getBriefSectionContent(
  markdown: string,
  heading: string,
  legacyHeadings: readonly string[] = []
): string {
  const candidates = [heading, ...legacyHeadings];
  for (const candidate of candidates) {
    const start = markdown.indexOf(candidate);
    if (start === -1) continue;
    const afterHeading = start + candidate.length;
    const nextHeading = markdown.slice(afterHeading).search(/\n##\s+\d+\./);
    const end = nextHeading === -1 ? markdown.length : afterHeading + nextHeading;
    return markdown.slice(afterHeading, end).trim();
  }
  return '';
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

function formatTrialLabel(value?: string | null): string {
  return (value || '').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function StructuredFeedSuggestions({ suggestions }: { suggestions?: HealthCaseFeedSuggestion[] }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div className="mt-4 grid gap-3">
      {suggestions.slice(0, 2).map((suggestion) => (
        <HealthCaseFeedCard key={suggestion.topic} suggestion={suggestion} />
      ))}
    </div>
  );
}

function contactRequestStorageKey(caseId: string): string {
  return `health-case-contact-requests:${caseId}`;
}

function loadRequestedResearcherKeys(caseId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(contactRequestStorageKey(caseId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveRequestedResearcherKeys(caseId: string, keys: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(contactRequestStorageKey(caseId), JSON.stringify(Array.from(keys)));
  } catch {
    // Best-effort duplicate suppression; the backend alert still handles the request.
  }
}

function HealthCaseFeedCard({ suggestion }: { suggestion: HealthCaseFeedSuggestion }) {
  const queryClient = useQueryClient();
  const [, setOpenFeed] = useQueryState('feed');
  const [state, setState] = useState<'default' | 'creating' | 'success' | 'error'>('default');
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (state === 'creating') return;
    setState('creating');
    setError('');
    try {
      const response = await authFetch(
        '/user/feeds/add',
        { method: 'POST' },
        z.object({ user_data: UserDataSchema, new_feed: z.string().nullable() }),
        {
          feed_title: suggestion.topic,
          key_phrases: [suggestion.topic],
          search_terms: suggestion.search_terms || [],
        }
      );
      setOpenFeed(response.new_feed ? feedPhraseToId(response.new_feed) : null);
      queryClient.invalidateQueries({ queryKey: ['userData'] });
      queryClient.invalidateQueries({ queryKey: ['feed'] });
      queryClient.invalidateQueries({ queryKey: ['unseen'] });
      setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create feed');
      setState('error');
    }
  };

  return (
    <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-900/60 dark:bg-sky-950/20">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Ongoing Feed
          </p>
          <h4 className="mt-1 font-semibold text-neutral-950 dark:text-white">
            {suggestion.topic}
          </h4>
          <p className="mt-1 text-sm leading-6 text-neutral-700 dark:text-neutral-200">
            {suggestion.description}
          </p>
          {suggestion.search_terms?.length > 0 && (
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Search terms: {suggestion.search_terms.slice(0, 6).join(', ')}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>}
        </div>
        {state === 'success' ? (
          <Link
            href={`/?feed=${feedPhraseToId(suggestion.topic)}`}
            className="w-fit rounded-xl bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-700"
          >
            View Feed
          </Link>
        ) : (
          <button
            type="button"
            onClick={handleCreate}
            disabled={state === 'creating'}
            className="w-fit rounded-xl bg-neutral-950 px-3 py-2 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-100"
          >
            {state === 'creating' ? 'Creating...' : state === 'error' ? 'Retry' : 'Create Feed'}
          </button>
        )}
      </div>
    </div>
  );
}

function ResearcherCards({
  caseId,
  researchers,
}: {
  caseId: string;
  researchers?: HealthCaseResearcher[];
}) {
  const [requestedResearcherKeys, setRequestedResearcherKeys] = useState<Set<string>>(() =>
    loadRequestedResearcherKeys(caseId)
  );
  if (!researchers || researchers.length === 0) return null;
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {researchers.map((researcher) => {
        const profileHref = researcher.profile_url?.startsWith('/authors/')
          ? researcher.profile_url
          : null;
        const researcherKey = `${
          researcher.synapse_id ||
          researcher.openalex_id ||
          `${researcher.name}-${researcher.institution || ''}-${researcher.specialty || ''}-${researcher.profile_url || ''}`
        }`;
        return (
          <ResearcherContactCard
            key={`${researcher.name}-${researcherKey}`}
            caseId={caseId}
            researcher={researcher}
            profileHref={profileHref}
            requested={requestedResearcherKeys.has(researcherKey)}
            onRequested={() => {
              setRequestedResearcherKeys((previous) => {
                const next = new Set(previous);
                next.add(researcherKey);
                saveRequestedResearcherKeys(caseId, next);
                return next;
              });
            }}
          />
        );
      })}
    </div>
  );
}

function ResearcherContactCard({
  caseId,
  researcher,
  profileHref,
  requested,
  onRequested,
}: {
  caseId: string;
  researcher: HealthCaseResearcher;
  profileHref: string | null;
  requested: boolean;
  onRequested: () => void;
}) {
  const contactRequest = useRequestHealthCaseResearcherContact(caseId);

  const handleRequestContact = async () => {
    try {
      await contactRequest.mutateAsync({
        researcher_name: researcher.name,
        researcher_openalex_id: researcher.openalex_id || '',
        researcher_synapse_id: researcher.synapse_id || '',
        researcher_profile_url: researcher.profile_url || '',
        researcher_institution: researcher.institution || '',
        researcher_specialty: researcher.specialty || '',
      });
      onRequested();
    } catch {
      // React Query exposes the visible error state via contactRequest.isError.
    }
  };

  return (
    <article className="rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/45">
      <div className="flex items-start gap-3">
        {researcher.image_url ? (
          <img
            src={researcher.image_url}
            alt={researcher.name}
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-200">
            {getInitials(researcher.name)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold text-neutral-950 dark:text-white">{researcher.name}</h4>
            {!researcher.matched && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                profile not matched
              </span>
            )}
          </div>
          {(researcher.institution || researcher.specialty) && (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {[researcher.specialty, researcher.institution].filter(Boolean).join(' · ')}
            </p>
          )}
          {researcher.rationale && (
            <p className="mt-3 text-sm leading-6 text-neutral-700 dark:text-neutral-200">
              {researcher.rationale}
            </p>
          )}
          {researcher.areas_of_expertise && researcher.areas_of_expertise.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {researcher.areas_of_expertise.slice(0, 4).map((area) => (
                <span
                  key={area}
                  className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
                >
                  {area}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {profileHref && (
              <Link
                href={profileHref}
                className="rounded-xl bg-neutral-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-100"
              >
                View profile
              </Link>
            )}
            {requested ? (
              <div className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                <span aria-hidden>✓</span>
                <span>Synapse team will outreach to this researcher on your behalf.</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleRequestContact}
                disabled={contactRequest.isPending}
                className="rounded-xl border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-sky-300 hover:bg-sky-50 disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:border-sky-800 dark:hover:bg-sky-950/30"
              >
                {contactRequest.isPending
                  ? 'Requesting...'
                  : researcher.action_label || 'Request Contact'}
              </button>
            )}
          </div>
          {contactRequest.isError && !requested && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-300">
              Could not send the request. Please try again.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function ClinicalTrialCards({ trials }: { trials?: HealthCaseClinicalTrial[] }) {
  if (!trials || trials.length === 0) return null;
  return (
    <div className="mt-4 grid gap-3">
      {trials.map((trial) => {
        const href = safeHref(trial.url || `https://clinicaltrials.gov/study/${trial.nct_id}`);
        const phases = (
          trial.phases && trial.phases.length > 0 ? trial.phases : [trial.phase]
        ).filter((phase): phase is string => Boolean(phase));
        const interventionNames = (trial.interventions || [])
          .map((item) => item.name)
          .filter(Boolean)
          .slice(0, 3);
        return (
          <article
            key={trial.nct_id}
            className="rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/45"
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                    {trial.nct_id}
                  </span>
                  {trial.status && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                      {formatTrialLabel(trial.status)}
                    </span>
                  )}
                  {phases.map((phase) => (
                    <span
                      key={phase}
                      className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
                    >
                      {formatTrialLabel(phase)}
                    </span>
                  ))}
                </div>
                <h4 className="mt-2 font-semibold text-neutral-950 dark:text-white">
                  {trial.title || 'Clinical trial'}
                </h4>
                {(trial.lead_sponsor_name || trial.enrollment) && (
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {[
                      trial.lead_sponsor_name,
                      trial.enrollment ? `${trial.enrollment} enrolled` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-fit rounded-xl bg-neutral-950 px-3 py-2 text-xs font-medium text-white transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-100"
                >
                  ClinicalTrials.gov
                </a>
              )}
            </div>
            {trial.fit_rationale && (
              <p className="mt-3 text-sm leading-6 text-neutral-700 dark:text-neutral-200">
                {trial.fit_rationale}
              </p>
            )}
            {interventionNames.length > 0 && (
              <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                Interventions: {interventionNames.join(', ')}
              </p>
            )}
            {trial.primary_outcomes && trial.primary_outcomes.length > 0 && (
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Primary outcome: {trial.primary_outcomes[0].measure}
                {trial.primary_outcomes[0].time_frame
                  ? ` (${trial.primary_outcomes[0].time_frame})`
                  : ''}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function ExpertResearchBrief({
  caseId,
  content,
  researchers,
  clinicalTrials,
  feedSuggestions,
}: {
  caseId: string;
  content: string;
  researchers?: HealthCaseResearcher[];
  clinicalTrials?: HealthCaseClinicalTrial[];
  feedSuggestions?: HealthCaseFeedSuggestion[];
}) {
  const hasStructuredSections = briefSections.some(
    (section) =>
      content.includes(section.heading) ||
      (section.legacyHeadings ?? []).some((legacy) => content.includes(legacy))
  );

  if (!hasStructuredSections) {
    return (
      <article
        className="mt-2 rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-200"
        data-posthog-mask
      >
        <MarkdownContent content={content} />
      </article>
    );
  }

  return (
    <div className="mt-2 grid gap-4">
      {briefSections.map((section) => {
        const sectionContent = getBriefSectionContent(
          content,
          section.heading,
          section.legacyHeadings
        );
        return (
          <section
            key={section.id}
            className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                  Expert Research
                </p>
                <h3 className="mt-1 text-lg font-semibold text-neutral-950 dark:text-white">
                  {section.title}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {section.description}
                </p>
              </div>
              {section.cta && (
                <button
                  type="button"
                  className="w-fit rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm font-medium text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                >
                  {section.cta}
                </button>
              )}
            </div>
            <div
              className="mt-4 text-sm leading-6 text-neutral-700 dark:text-neutral-200"
              data-posthog-mask
            >
              {sectionContent ? (
                <MarkdownContent content={sectionContent} />
              ) : (
                <p className="italic text-neutral-500">
                  Synapse is still generating this section...
                </p>
              )}
              {section.id === 'papers' && (
                <StructuredFeedSuggestions suggestions={feedSuggestions} />
              )}
              {section.id === 'researchers' && (
                <ResearcherCards key={caseId} caseId={caseId} researchers={researchers} />
              )}
              {section.id === 'trials' && <ClinicalTrialCards trials={clinicalTrials} />}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function BetaCardiologyPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
      Beta · Google ADK multi-agent research
    </span>
  );
}

type IntakeMessage = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  attachments?: string[];
};

const initialIntakeMessage: IntakeMessage = {
  id: 'assistant-initial',
  role: 'assistant',
  content:
    "Let's build the Health Case together. Tell me who this is for, what has happened so far, and what decision you're trying to make. Attach any records — labs, imaging reports, discharge summaries — whenever they help.",
};

function formatIntakeAssistantMessage(intake: HealthCaseIntake): string {
  const questions = intake.follow_up_questions || [];
  if (questions.length === 0) return intake.assistant_message;
  return `${intake.assistant_message}\n\nA few follow-ups that would help:\n${questions
    .map((question, index) => `${index + 1}. ${question}`)
    .join('\n')}`;
}

function ChatComposer({
  draft,
  setDraft,
  onSubmit,
  files,
  onAddFiles,
  onRemoveFile,
  isSubmitting,
  pendingLabel,
  submitLabel,
  placeholder,
  helperText,
  acceptFiles = '.pdf,.txt,.md,image/jpeg,image/png,image/webp',
  allowFiles = true,
  disabled = false,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: () => void;
  files: File[];
  onAddFiles: (next: File[]) => void;
  onRemoveFile: (file: File) => void;
  isSubmitting: boolean;
  pendingLabel: string;
  submitLabel: string;
  placeholder: string;
  helperText?: string;
  acceptFiles?: string;
  allowFiles?: boolean;
  disabled?: boolean;
}) {
  const canSubmit = !disabled && !isSubmitting && (draft.trim().length > 0 || files.length > 0);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit();
  };

  return (
    <BorderBeam size="md" duration={8} colorVariant="ocean" theme="auto" className="w-full">
      <form
        onSubmit={handleSubmit}
        className="rounded-[30px] bg-white/95 p-3 shadow-[0_18px_70px_rgba(2,24,44,0.1)] backdrop-blur-xl dark:bg-neutral-950/95"
      >
        <div className="flex items-start gap-3">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
            placeholder={placeholder}
            className="min-h-16 flex-1 resize-none rounded-2xl border-0 bg-transparent px-3 py-3 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white"
            data-posthog-mask
            aria-label="Message"
          />
          <Button type="submit" className="mt-1 h-11 min-w-24 rounded-2xl" disabled={!canSubmit}>
            {isSubmitting ? pendingLabel : submitLabel}
          </Button>
        </div>

        {files.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
            {files.map((file) => (
              <button
                key={`${file.name}-${file.size}-${file.lastModified}`}
                type="button"
                onClick={() => onRemoveFile(file)}
                className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-700 transition hover:border-red-200 hover:text-red-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
                title="Remove file"
                data-posthog-mask
              >
                {file.name} · {formatFileSize(file.size)} · remove
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-3 border-t border-neutral-100 pt-3 dark:border-neutral-800 sm:flex-row sm:items-center sm:justify-between">
          {allowFiles ? (
            <label className="inline-flex w-fit cursor-pointer items-center justify-center rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800">
              Attach records
              <input
                type="file"
                multiple
                accept={acceptFiles}
                className="sr-only"
                onChange={(event) => {
                  const selected = Array.from(event.target.files || []);
                  onAddFiles(selected);
                  event.target.value = '';
                }}
              />
            </label>
          ) : (
            <span />
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {helperText ?? 'Press Enter to send · Shift + Enter for a new line'}
          </p>
        </div>
      </form>
    </BorderBeam>
  );
}

function CreateCaseCard() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const intakeCase = useHealthCaseIntake();
  const createCase = useCreateHealthCase();
  const updateProfile = useUpdateHealthCaseProfile();
  const uploadDocuments = useUploadHealthCaseDocument();
  const [messages, setMessages] = useState<IntakeMessage[]>([initialIntakeMessage]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [allFiles, setAllFiles] = useState<File[]>([]);
  const [intake, setIntake] = useState<HealthCaseIntake | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');
  const [actionError, setActionError] = useState('');
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const isSubmitting = intakeCase.isPending || createCase.isPending || uploadDocuments.isPending;

  const userStory = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n\n');

  const removeFile = (fileToRemove: File) => {
    setIntake(null);
    setFiles((current) =>
      current.filter(
        (file) =>
          file.name !== fileToRemove.name ||
          file.size !== fileToRemove.size ||
          file.lastModified !== fileToRemove.lastModified
      )
    );
  };

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, intakeCase.isPending]);

  const submitTurn = async () => {
    if (!draft.trim() && files.length === 0) return;
    const trimmed = draft.trim();
    const turnFiles = files;
    const userMessage: IntakeMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed || 'I attached records for you to review.',
      attachments: turnFiles.map((file) => file.name),
    };
    const nextMessages = [...messages, userMessage];

    if (intake && trimmed && isAffirmative(trimmed) && turnFiles.length === 0) {
      setMessages(nextMessages);
      setDraft('');
      await confirmAndCreate(nextMessages);
      return;
    }

    setMessages(nextMessages);
    setDraft('');
    setIntake(null);
    setActionError('');

    const transcript = nextMessages
      .map((message) => `${message.role === 'assistant' ? 'Synapse' : 'User'}: ${message.content}`)
      .join('\n\n');
    try {
      const result = await intakeCase.mutateAsync({ story: transcript, files: turnFiles });
      const uploadedFileNames = turnFiles.map((file) => file.name);
      setAllFiles((current) => [...current, ...turnFiles]);
      setFiles([]);
      setIntake(result);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: formatIntakeAssistantMessage(result),
          attachments: uploadedFileNames,
        },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Health Case intake failed';
      setActionError(message);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-error-${Date.now()}`,
          role: 'assistant',
          content:
            "I couldn't read that intake turn. Your message is still visible above; please try sending it again or attach fewer records.",
        },
      ]);
    }
  };

  const confirmAndCreate = async (transcriptMessages?: IntakeMessage[]) => {
    if (!intake) return;
    let createdCaseId: string | null = null;
    setActionError('');
    try {
      const created = await createCase.mutateAsync({
        title: intake.title || deriveCaseTitle(userStory),
        condition_terms: intake.condition_terms?.length
          ? intake.condition_terms
          : deriveConditionTerms(userStory),
      });
      createdCaseId = created.id;
      // Persist the full transcript IMMEDIATELY after the case is created so
      // the detail page has the conversational context even if profile-update
      // or upload throws partway through. Otherwise a flaky upload would
      // redirect the user to a fresh-looking case with no chat history.
      try {
        const handoff = {
          messages: transcriptMessages || messages,
          createdAt: new Date().toISOString(),
        };
        sessionStorage.setItem(`health-case-intake:${created.id}`, JSON.stringify(handoff));
      } catch {
        // sessionStorage can throw in private modes; the detail page degrades gracefully.
      }
      if (intake.profile) {
        await updateProfile.mutateAsync({
          ...intake.profile,
          caseId: created.id,
          notes: intake.profile.notes || userStory,
        });
      }
      for (const [index, file] of allFiles.entries()) {
        setUploadProgress(`Uploading ${index + 1} of ${allFiles.length}: ${file.name}`);
        await uploadDocuments.mutateAsync({ caseId: created.id, file });
      }
      router.push(`/health-cases/${created.id}?continue=1`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not finish Health Case setup';
      setActionError(message);
      if (createdCaseId) {
        router.push(`/health-cases/${createdCaseId}`);
      }
    }
  };

  return (
    <BorderBeam size="md" duration={9} colorVariant="ocean" theme="auto" className="w-full">
      <motion.section
        className="relative overflow-hidden rounded-[36px] synapse-glass-strong"
        initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 360, damping: 34 }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(78,157,252,0.16),transparent_28rem),radial-gradient(circle_at_80%_10%,rgba(129,140,248,0.12),transparent_24rem)]" />
        <div className="relative border-b border-black/5 px-5 py-5 dark:border-white/[0.07] md:px-8 md:py-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-light)] text-[var(--accent)]">
                  <SynapseIcon className="h-5 w-5" isFilled />
                </div>
                <div>
                  <p className="text-sm font-semibold text-sky-700 dark:text-sky-300">
                    Synapse intake
                  </p>
                  <h2 className="text-2xl font-bold tracking-tight text-neutral-950 dark:text-white md:text-3xl">
                    Chat through the case.
                  </h2>
                </div>
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                Tell us about the case in plain English. Attach records when they help. When the
                summary looks right, just reply &ldquo;yes&rdquo; and we&rsquo;ll generate the
                Expert Research brief.
              </p>
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/55 px-4 py-3 text-xs text-neutral-600 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-300">
              Private intake · PDF-aware · confirm before saving
            </div>
          </div>
        </div>

        <div className="relative space-y-5 p-4 md:p-6 lg:p-8">
          <div className="max-h-[520px] min-h-[280px] space-y-5 overflow-y-auto rounded-[30px] border border-white/70 bg-white/45 p-4 pr-2 shadow-inner dark:border-white/[0.06] dark:bg-black/10 md:p-6">
            {messages.map((message) => (
              <ChatBubble
                key={message.id}
                role={message.role}
                content={message.content}
                attachments={message.attachments}
              />
            ))}
            {intakeCase.isPending && <ChatTypingBubble label="Reading the case and records" />}
            {intake && !intakeCase.isPending && (
              <ChatBubble role="assistant" inline>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
                  <p className="font-semibold">Ready to create the Health Case?</p>
                  <p className="mt-2" data-posthog-mask>
                    Reply <span className="font-mono">yes</span> to save this intake and start
                    Expert Research, or keep chatting and I&rsquo;ll update the summary before
                    anything is saved.
                  </p>
                  {intake.records_read.length > 0 && (
                    <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900">
                      <p className="font-medium">Records read:</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {intake.records_read.map((record) => (
                          <span
                            key={`${record.filename}-${record.status}`}
                            className="rounded-full bg-white/70 px-3 py-1 text-xs dark:bg-neutral-900/70"
                            data-posthog-mask
                          >
                            {record.filename} · {record.status}
                            {record.word_count ? ` · ${record.word_count} words` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <Button
                    className="mt-4"
                    onClick={() => confirmAndCreate()}
                    disabled={isSubmitting}
                  >
                    {createCase.isPending || uploadDocuments.isPending
                      ? 'Creating...'
                      : 'Yes — create Health Case'}
                  </Button>
                </div>
              </ChatBubble>
            )}
            <div ref={endOfMessagesRef} />
          </div>

          <ChatComposer
            draft={draft}
            setDraft={setDraft}
            onSubmit={submitTurn}
            files={files}
            onAddFiles={(selected) => {
              setFiles((current) => [...current, ...selected]);
              setIntake(null);
            }}
            onRemoveFile={removeFile}
            isSubmitting={intakeCase.isPending}
            pendingLabel="Reading..."
            submitLabel={intake ? 'Send' : 'Send'}
            placeholder={
              intake
                ? "Reply 'yes' to confirm, or share more context to refine the summary..."
                : 'Reply here: diagnosis, symptoms, medications, goals, or answer the follow-up...'
            }
          />

          {(actionError ||
            intakeCase.error ||
            createCase.error ||
            uploadDocuments.error ||
            updateProfile.error) && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {actionError ||
                intakeCase.error?.message ||
                createCase.error?.message ||
                uploadDocuments.error?.message ||
                updateProfile.error?.message}
            </p>
          )}
          {uploadProgress && <p className="text-xs text-neutral-500">{uploadProgress}</p>}
        </div>
      </motion.section>
    </BorderBeam>
  );
}

function ChatBubble({
  role,
  content,
  attachments,
  inline,
  children,
}: {
  role: 'assistant' | 'user';
  content?: string;
  attachments?: string[];
  inline?: boolean;
  children?: React.ReactNode;
}) {
  const isAssistant = role === 'assistant';
  // Assistant text bubbles render markdown so the case-summary card and any
  // other Gemini-formatted prose ("**Conditions of interest:** …") show
  // bold/italic/lists instead of raw `**` / `-` markers. User bubbles stay
  // as plain whitespace-preserved text — they're verbatim user input and
  // markdown rendering would surprise typists.
  const renderMarkdown = isAssistant && !children && typeof content === 'string';
  return (
    <div className={`flex gap-3 ${isAssistant ? '' : 'justify-end'}`}>
      {isAssistant && (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#02182c] text-white shadow-[0_8px_24px_rgba(2,24,44,0.22)] dark:bg-white dark:text-neutral-950">
          <SynapseIcon className="h-4 w-4" isFilled />
        </div>
      )}
      <div
        className={
          inline
            ? 'max-w-[88%] flex-1'
            : `max-w-[88%] rounded-3xl p-4 text-sm shadow-sm ${
                isAssistant
                  ? 'rounded-tl-md border border-neutral-200 bg-white text-neutral-700 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200'
                  : 'rounded-tr-md whitespace-pre-wrap bg-[#02182c] text-white dark:bg-white dark:text-neutral-950'
              }`
        }
        data-posthog-mask
      >
        {children ?? (renderMarkdown ? <MarkdownContent content={content!} /> : content)}
        {!children && attachments && attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {attachments.map((name) => (
              <span
                key={name}
                className="rounded-full bg-white/15 px-2 py-1 text-xs dark:bg-neutral-900/10"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatTypingBubble({ label }: { label: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#02182c] text-white shadow-[0_8px_24px_rgba(2,24,44,0.22)] dark:bg-white dark:text-neutral-950">
        <SynapseIcon className="h-4 w-4" isFilled />
      </div>
      <div className="rounded-3xl rounded-tl-md border border-neutral-200 bg-white p-4 text-sm text-neutral-500 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        {label}
        <AnimatedDots />
      </div>
    </div>
  );
}

export function HealthCasesDashboard() {
  const { data, isLoading, error } = useHealthCases();

  return (
    <div className="synapse-page-bg min-h-screen">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-4 py-8 md:p-8">
        <section className="mx-auto w-full max-w-5xl text-center">
          <div className="flex justify-center">
            <BetaCardiologyPill />
          </div>
          <h1 className="mx-auto mt-4 max-w-4xl text-4xl font-bold tracking-tight text-neutral-950 dark:text-white md:text-6xl">
            Tell us about your case. We&rsquo;ll bring back the latest expert perspectives.
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-base leading-7 text-neutral-600 dark:text-neutral-300 md:text-lg">
            Chat through the case in plain English and attach any records you have. Synapse comes
            back with what the experts are saying, who&rsquo;s working on it, the relevant clinical
            trials, and the latest research papers — every claim cited. Behind the scenes, a Google
            ADK agent team splits evidence, trial, and researcher discovery before synthesizing the
            brief. While we&rsquo;re in beta we focus on cardiology cases.
          </p>
          <p className="mx-auto mt-3 max-w-2xl text-xs text-neutral-500 dark:text-neutral-400">
            Educational research only — not a diagnosis or medical advice. Records are encrypted and
            only used for your case.
          </p>
        </section>

        <CreateCaseCard />

        <section className="synapse-card rounded-[28px] p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Saved workspace
              </p>
              <h2 className="text-xl font-semibold text-neutral-950 dark:text-white">
                Your Health Cases
              </h2>
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Confirmed cases, uploaded records, and generated briefs live here.
            </p>
          </div>
          {isLoading && <LoadingSpinner />}
          {error && <p className="mt-4 text-sm text-red-600">{error.message}</p>}
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {(data || []).length === 0 && !isLoading ? (
              <p className="rounded-2xl border border-dashed border-neutral-300 p-5 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300 md:col-span-2">
                No Health Cases yet. Create one above to upload records and generate Expert
                Research.
              </p>
            ) : null}
            {(data || []).map((healthCase) => (
              <Link
                key={healthCase.id}
                href={`/health-cases/${healthCase.id}`}
                className="block rounded-2xl border border-neutral-200 p-4 transition hover:border-sky-300 hover:bg-sky-50/50 dark:border-neutral-800 dark:hover:border-sky-900 dark:hover:bg-sky-950/20"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-neutral-950 dark:text-white">
                      {healthCase.title}
                    </h3>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                      {(healthCase.condition_terms || []).join(', ') || 'Cardiology case'}
                    </p>
                  </div>
                  <StatusBadge status={healthCase.status} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

type DetailMessage =
  | {
      kind: 'text';
      id: string;
      role: 'assistant' | 'user';
      content: string;
      attachments?: string[];
    }
  | {
      kind: 'brief';
      id: string;
      content: string;
      isStreaming: boolean;
      generatedAtIso?: string;
      researchers?: HealthCaseResearcher[];
      clinicalTrials?: HealthCaseClinicalTrial[];
      feedSuggestions?: HealthCaseFeedSuggestion[];
    }
  | {
      kind: 'error';
      id: string;
      content: string;
    };

function buildCaseSummary(healthCase: HealthCase): string {
  const profile = healthCase.profile || emptyProfile;
  const lines: string[] = [];
  lines.push(
    `Here's the **${healthCase.title}** Health Case as I have it. Reply \`yes\` to generate Expert Research, or send any clarifications, follow-up questions, or extra records to refine it first.`
  );
  if ((healthCase.condition_terms || []).length > 0) {
    lines.push(`\n**Conditions of interest:** ${healthCase.condition_terms.join(', ')}`);
  }
  if ((profile.symptoms || []).length > 0) {
    lines.push(`**Symptoms:** ${profile.symptoms.join(', ')}`);
  }
  if ((profile.medications || []).length > 0) {
    lines.push(`**Medications:** ${profile.medications.join(', ')}`);
  }
  if ((profile.procedures || []).length > 0) {
    lines.push(`**Procedures:** ${profile.procedures.join(', ')}`);
  }
  if ((profile.goals || []).length > 0) {
    lines.push(`**Goals:** ${profile.goals.join(', ')}`);
  }
  if ((profile.questions || []).length > 0) {
    lines.push(`**Questions for Synapse:** ${profile.questions.join(', ')}`);
  }
  return lines.join('\n');
}

function loadIntakeHandoff(caseId: string): IntakeMessage[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(`health-case-intake:${caseId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { messages?: IntakeMessage[] };
    if (!parsed?.messages || !Array.isArray(parsed.messages)) return null;
    return parsed.messages;
  } catch {
    return null;
  }
}

function DownloadBriefPdfButton({
  caseTitle,
  conditionTerms,
  briefContent,
  generatedAtIso,
  researchers,
  clinicalTrials,
  feedSuggestions,
  variant = 'outline',
  className = '',
  label = 'Download PDF',
}: {
  caseTitle: string;
  conditionTerms: string[];
  briefContent: string;
  generatedAtIso?: string;
  researchers?: HealthCaseResearcher[];
  clinicalTrials?: HealthCaseClinicalTrial[];
  feedSuggestions?: HealthCaseFeedSuggestion[];
  variant?: 'default' | 'outline';
  className?: string;
  label?: string;
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (isGenerating) return;
    setError(null);
    setIsGenerating(true);
    try {
      // Lazy-load both modules so the heavy PDF runtime ships only on click.
      const [{ pdf }, { BriefPdfDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./BriefPdfDocument'),
      ]);
      // Embed the Synapse logo as a data URL — @react-pdf/renderer's <Image>
      // resolves cross-origin URLs at render time, but a base64 source removes
      // any chance of the PDF rendering without our brand mark.
      let logoSrc: string | undefined;
      try {
        const response = await fetch('/synapse-logo.png');
        if (response.ok) {
          const blob = await response.blob();
          logoSrc = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }
      } catch {
        // Ship without the logo image rather than failing the download.
      }

      const parsed = parseBrief(briefContent);
      const docElement = (
        <BriefPdfDocument
          caseTitle={caseTitle || 'Health Case'}
          conditionTerms={conditionTerms}
          brief={parsed}
          generatedAtIso={generatedAtIso || new Date().toISOString()}
          logoSrc={logoSrc}
          researchers={researchers}
          clinicalTrials={clinicalTrials}
          feedSuggestions={feedSuggestions}
        />
      );
      const blob = await pdf(docElement).toBlob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = safeFilename(caseTitle || 'expert-research');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoke on the next tick so Safari has a chance to start the download.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PDF download failed';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <Button
        variant={variant}
        onClick={handleDownload}
        disabled={isGenerating || !briefContent.trim()}
      >
        {isGenerating ? 'Preparing PDF...' : label}
      </Button>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function clearIntakeHandoff(caseId: string) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(`health-case-intake:${caseId}`);
  } catch {
    // ignore
  }
}

function ProfileEditorInline({
  caseId,
  profile,
  onSaved,
  onCancel,
}: {
  caseId: string;
  profile: HealthCaseProfile | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const updateProfile = useUpdateHealthCaseProfile(caseId);
  const initial = profile || emptyProfile;
  const [conditions, setConditions] = useState(joinLines(initial.conditions));
  const [symptoms, setSymptoms] = useState(joinLines(initial.symptoms));
  const [medications, setMedications] = useState(joinLines(initial.medications));
  const [procedures, setProcedures] = useState(joinLines(initial.procedures));
  const [goals, setGoals] = useState(joinLines(initial.goals));
  const [questions, setQuestions] = useState(joinLines(initial.questions));
  const [notes, setNotes] = useState(initial.notes || '');

  const save = async () => {
    await updateProfile.mutateAsync({
      ...emptyProfile,
      conditions: splitLines(conditions),
      symptoms: splitLines(symptoms),
      medications: splitLines(medications),
      procedures: splitLines(procedures),
      goals: splitLines(goals),
      questions: splitLines(questions),
      notes,
    });
    onSaved();
  };

  return (
    <div
      className="rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900/40"
      data-posthog-mask
    >
      <p className="text-sm font-semibold text-neutral-900 dark:text-white">Edit case facts</p>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        One item per line. Saving will update the brief next time you generate.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {[
          ['Conditions', conditions, setConditions],
          ['Symptoms', symptoms, setSymptoms],
          ['Medications', medications, setMedications],
          ['Procedures', procedures, setProcedures],
          ['Goals', goals, setGoals],
          ['Questions for Synapse', questions, setQuestions],
        ].map(([label, value, setter]) => (
          <label key={label as string} className="block space-y-1.5">
            <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              {label as string}
            </span>
            <textarea
              value={value as string}
              onChange={(event) => (setter as (value: string) => void)(event.target.value)}
              className="min-h-24 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
              data-posthog-mask
            />
          </label>
        ))}
      </div>
      <label className="mt-3 block space-y-1.5">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Additional notes
        </span>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="min-h-24 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
          data-posthog-mask
        />
      </label>
      {updateProfile.error && (
        <p className="mt-3 text-sm text-red-600">{updateProfile.error.message}</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={save} disabled={updateProfile.isPending}>
          {updateProfile.isPending ? 'Saving...' : 'Save case facts'}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={updateProfile.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function HealthCaseDetail({ caseId }: { caseId: string }) {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useHealthCase(caseId);
  const deleteCase = useDeleteHealthCase();
  const upload = useUploadHealthCaseDocument(caseId);
  const updateProfile = useUpdateHealthCaseProfile(caseId);
  const brief = useGenerateHealthCaseBrief(caseId);

  const [messages, setMessages] = useState<DetailMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [actionError, setActionError] = useState('');
  const [activeBriefMessageId, setActiveBriefMessageId] = useState<string | null>(null);
  const seededRef = useRef(false);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  // Synchronous lock for the brief-generation guard. `useState` /
  // `activeBriefMessageId` would lag behind a fast double-click because the
  // state setter is queued for the next render — a `useRef` flips
  // immediately and is shared across closures.
  const briefGenerationLock = useRef(false);

  // Seed messages from the prior intake transcript + current case state.
  useEffect(() => {
    if (seededRef.current || !data) return;
    seededRef.current = true;

    const seeded: DetailMessage[] = [];
    const handoff = loadIntakeHandoff(caseId);
    if (handoff) {
      for (const message of handoff) {
        seeded.push({
          kind: 'text',
          id: message.id,
          role: message.role,
          content: message.content,
          attachments: message.attachments,
        });
      }
      clearIntakeHandoff(caseId);
    }

    seeded.push({
      kind: 'text',
      id: `case-summary-${data.updated_at || data.id}`,
      role: 'assistant',
      content: buildCaseSummary(data),
    });

    // Replay any saved briefs as historical assistant messages.
    for (const savedBrief of data.briefs || []) {
      const content =
        savedBrief.sections?.expert_research ||
        (savedBrief.error_message ? `Earlier brief failed: ${savedBrief.error_message}` : '');
      if (!content) continue;
      if (savedBrief.status === 'failed') {
        seeded.push({ kind: 'error', id: `brief-${savedBrief.id}`, content });
      } else {
        seeded.push({
          kind: 'brief',
          id: `brief-${savedBrief.id}`,
          content,
          isStreaming: false,
          generatedAtIso: savedBrief.created_at || undefined,
          researchers: savedBrief.researchers || [],
          clinicalTrials: savedBrief.clinical_trials || [],
          feedSuggestions: savedBrief.feed_suggestions || [],
        });
      }
    }

    setMessages(seeded);
  }, [data, caseId]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, brief.isStreaming, brief.content]);

  // Stream brief content into the active assistant brief message.
  useEffect(() => {
    if (!activeBriefMessageId) return;
    setMessages((current) =>
      current.map((message) =>
        message.kind === 'brief' && message.id === activeBriefMessageId
          ? {
              ...message,
              content: brief.content,
              isStreaming: brief.isStreaming,
              researchers: brief.savedBrief?.researchers || message.researchers,
              clinicalTrials: brief.savedBrief?.clinical_trials || message.clinicalTrials,
              feedSuggestions: brief.savedBrief?.feed_suggestions || message.feedSuggestions,
              generatedAtIso: brief.savedBrief?.created_at || message.generatedAtIso,
            }
          : message
      )
    );
  }, [activeBriefMessageId, brief.content, brief.isStreaming, brief.savedBrief]);

  // When the brief stream ends, refetch case to pick up status + saved brief.
  useEffect(() => {
    if (!activeBriefMessageId) return;
    if (brief.isStreaming) return;
    if (brief.error) {
      const errorContent = brief.error;
      setMessages((current) => [
        ...current.filter((message) => message.id !== activeBriefMessageId),
        {
          kind: 'error',
          id: `brief-error-${Date.now()}`,
          content: errorContent,
        },
      ]);
      setActiveBriefMessageId(null);
      refetch();
      return;
    }
    if (brief.content) {
      setActiveBriefMessageId(null);
      refetch();
    }
  }, [brief.isStreaming, brief.error, brief.content, activeBriefMessageId, refetch]);

  const canGenerate = useMemo(() => {
    if (!data) return false;
    if (brief.isStreaming) return false;
    return ['profile_confirmed', 'ready', 'failed'].includes(data.status);
  }, [data, brief.isStreaming]);

  const startBrief = useCallback(
    async (followUp?: string) => {
      if (!data) return;
      // Guard against a double-fire from "click button + reply yes" or a
      // double-click before `isStreaming` flips. The backend's atomic
      // `modify` already rejects the second request with a 409, but a
      // second client-side call would also overwrite `activeBriefMessageId`
      // and orphan the first brief card in the chat. We use a `useRef`
      // flag rather than `activeBriefMessageId` because React batches
      // state updates and the closure here would otherwise see the stale
      // pre-click value across rapid double-clicks.
      if (briefGenerationLock.current || brief.isStreaming) return;
      briefGenerationLock.current = true;
      setActionError('');

      // If profile has never been confirmed (still draft / extracting), confirm it first.
      const needsConfirm =
        data.status === 'draft' ||
        data.status === 'extracting' ||
        data.status === 'ready_for_review';
      if (needsConfirm) {
        try {
          await updateProfile.mutateAsync({
            ...emptyProfile,
            ...(data.profile || emptyProfile),
          });
        } catch (err) {
          setActionError(
            err instanceof Error ? err.message : 'Could not confirm Health Case profile'
          );
          briefGenerationLock.current = false;
          return;
        }
      }

      const userText = followUp?.trim() || 'Yes — generate the Expert Research brief.';
      const userMessage: DetailMessage = {
        kind: 'text',
        id: `user-${Date.now()}`,
        role: 'user',
        content: userText,
      };
      const briefId = `brief-${Date.now()}`;
      setMessages((current) => [
        ...current,
        userMessage,
        { kind: 'brief', id: briefId, content: '', isStreaming: true },
      ]);
      setActiveBriefMessageId(briefId);
      // `generate` is async — await so synchronous failures inside the hook
      // surface here instead of being silently dropped on the floor. The
      // streaming-state useEffect below still drives incremental UI updates.
      try {
        await brief.generate(followUp);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Expert Research generation failed');
      } finally {
        // Release the synchronous double-fire lock once the request settles
        // (success, hook error, or stream completion). The follow-up
        // useEffect below clears `activeBriefMessageId` on the React side.
        briefGenerationLock.current = false;
      }
    },
    [brief, data, updateProfile]
  );

  const submitTurn = async () => {
    if (!data) return;
    const trimmed = draft.trim();
    const turnFiles = pendingFiles;
    if (!trimmed && turnFiles.length === 0) return;
    setDraft('');
    setActionError('');

    if (turnFiles.length > 0) {
      const userMessage: DetailMessage = {
        kind: 'text',
        id: `user-upload-${Date.now()}`,
        role: 'user',
        content: trimmed || 'Attaching more records to the case.',
        attachments: turnFiles.map((file) => file.name),
      };
      setMessages((current) => [...current, userMessage]);
      setPendingFiles([]);

      let uploadedCount = 0;
      let lastError: string | null = null;
      for (const file of turnFiles) {
        try {
          await upload.mutateAsync({ file });
          uploadedCount += 1;
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'Upload failed';
          break;
        }
      }
      if (lastError) {
        setMessages((current) => [
          ...current,
          {
            kind: 'error',
            id: `upload-error-${Date.now()}`,
            content: lastError as string,
          },
        ]);
        return;
      }
      setMessages((current) => [
        ...current,
        {
          kind: 'text',
          id: `upload-ack-${Date.now()}`,
          role: 'assistant',
          content: `Got ${uploadedCount} record${uploadedCount === 1 ? '' : 's'}. I'll fold them into the next Expert Research pass. Ready when you are — reply \`yes\` to generate.`,
        },
      ]);
      return;
    }

    if (isAffirmative(trimmed)) {
      await startBrief();
      return;
    }

    // Free-text replies are added to the transcript but DO NOT auto-trigger a
    // brief generation: a casual "what does afib mean?" or "I want to add
    // more later" should not burn an LLM pass. Users start a new brief
    // explicitly via the Generate button or by replying with an affirmative.
    setMessages((current) => [
      ...current,
      {
        kind: 'text',
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
      },
      {
        kind: 'text',
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content:
          'Got it — noted. To pull this into the brief, edit the case facts (button above) so the next pass picks it up, then reply `yes` or hit **Generate Expert Research**.',
      },
    ]);
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      'Delete this Health Case and its generated briefs? This cannot be undone.'
    );
    if (!confirmed) return;
    await deleteCase.mutateAsync(caseId);
    router.push('/health-cases');
  };

  if (isLoading) return <LoadingSpinner />;
  if (error) return <p className="p-8 text-sm text-red-600">{error.message}</p>;
  if (!data) return null;

  return (
    <div className="synapse-page-bg min-h-screen">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 py-8 md:p-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/health-cases" className="text-sm text-sky-700 hover:underline">
            ← Back to Health Cases
          </Link>
          <BetaCardiologyPill />
        </div>

        <section className="rounded-[32px] border border-neutral-200 bg-white/80 p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950/70 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold text-neutral-950 dark:text-white md:text-3xl">
                  {data.title}
                </h1>
                <StatusBadge status={data.status} />
              </div>
              <p className="mt-2 max-w-3xl text-sm text-neutral-600 dark:text-neutral-300">
                Educational research only — not a diagnosis or medical advice. Records are retained
                until you delete the case.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => setEditingProfile((value) => !value)}
                disabled={updateProfile.isPending}
              >
                {editingProfile ? 'Hide editor' : 'Edit case facts'}
              </Button>
              <Button
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-300"
                disabled={deleteCase.isPending}
                onClick={handleDelete}
              >
                Delete case
              </Button>
            </div>
          </div>

          {(data.documents || []).length > 0 && (
            <details className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50/60 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900/40">
              <summary className="cursor-pointer font-medium text-neutral-800 dark:text-neutral-200">
                {(data.documents || []).length} record
                {(data.documents || []).length === 1 ? '' : 's'} on file
              </summary>
              <div className="mt-3 space-y-2">
                {(data.documents || []).map((document) => (
                  <div
                    key={document.id}
                    className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div data-posthog-mask>
                        <p className="font-medium text-neutral-900 dark:text-white">
                          {document.filename}
                        </p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {document.content_type} · {Math.round(document.size_bytes / 1024)} KB
                          {document.extraction_summary?.word_count
                            ? ` · ~${document.extraction_summary.word_count} words extracted`
                            : ''}
                        </p>
                      </div>
                      <StatusBadge status={document.status} />
                    </div>
                    {document.error_message && (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        {document.error_message}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {editingProfile && (
            <div className="mt-4">
              <ProfileEditorInline
                caseId={caseId}
                profile={data.profile}
                onSaved={() => {
                  setEditingProfile(false);
                  refetch();
                }}
                onCancel={() => setEditingProfile(false)}
              />
            </div>
          )}
        </section>

        <BorderBeam size="md" duration={9} colorVariant="ocean" theme="auto" className="w-full">
          <section className="relative overflow-hidden rounded-[36px] synapse-glass-strong">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(78,157,252,0.16),transparent_28rem),radial-gradient(circle_at_80%_10%,rgba(129,140,248,0.12),transparent_24rem)]" />

            <div className="relative space-y-5 p-4 md:p-6 lg:p-8">
              <div className="max-h-[640px] min-h-[320px] space-y-5 overflow-y-auto rounded-[30px] border border-white/70 bg-white/45 p-4 pr-2 shadow-inner dark:border-white/[0.06] dark:bg-black/10 md:p-6">
                {messages.map((message) => {
                  if (message.kind === 'text') {
                    return (
                      <ChatBubble
                        key={message.id}
                        role={message.role}
                        content={message.content}
                        attachments={message.attachments}
                      />
                    );
                  }
                  if (message.kind === 'error') {
                    return (
                      <ChatBubble key={message.id} role="assistant" inline>
                        <div className="rounded-2xl border border-red-200 bg-red-50/80 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
                          <p className="font-semibold">Expert Research couldn&rsquo;t finish.</p>
                          <p className="mt-1" data-posthog-mask>
                            {message.content}
                          </p>
                          <Button
                            className="mt-3"
                            disabled={!canGenerate}
                            onClick={() => startBrief()}
                          >
                            Try generating again
                          </Button>
                        </div>
                      </ChatBubble>
                    );
                  }
                  const briefIsComplete = !message.isStreaming && message.content.trim().length > 0;
                  return (
                    <ChatBubble key={message.id} role="assistant" inline>
                      <div className="rounded-3xl rounded-tl-md border border-neutral-200 bg-white p-4 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                            Expert Research
                          </p>
                          {message.isStreaming ? (
                            <span className="text-xs text-neutral-500">
                              streaming
                              <AnimatedDots />
                            </span>
                          ) : briefIsComplete ? (
                            <DownloadBriefPdfButton
                              caseTitle={data.title}
                              conditionTerms={data.condition_terms || []}
                              briefContent={message.content}
                              generatedAtIso={message.generatedAtIso}
                              researchers={message.researchers}
                              clinicalTrials={message.clinicalTrials}
                              feedSuggestions={message.feedSuggestions}
                              variant="outline"
                              label="Download PDF"
                            />
                          ) : null}
                        </div>
                        {message.content ? (
                          <ExpertResearchBrief
                            caseId={data.id}
                            content={message.content}
                            researchers={message.researchers}
                            clinicalTrials={message.clinicalTrials}
                            feedSuggestions={message.feedSuggestions}
                          />
                        ) : (
                          <p className="mt-3 text-sm text-neutral-500">
                            Synapse is reading evidence, talking to its tools, and pulling
                            citations. This usually takes ~30s
                            <AnimatedDots />
                          </p>
                        )}
                      </div>
                    </ChatBubble>
                  );
                })}
                {brief.isStreaming && !activeBriefMessageId && (
                  <ChatTypingBubble label="Generating Expert Research" />
                )}
                <div ref={endOfMessagesRef} />
              </div>

              <ChatComposer
                draft={draft}
                setDraft={setDraft}
                onSubmit={submitTurn}
                files={pendingFiles}
                onAddFiles={(selected) => setPendingFiles((current) => [...current, ...selected])}
                onRemoveFile={(file) =>
                  setPendingFiles((current) =>
                    current.filter(
                      (item) =>
                        item.name !== file.name ||
                        item.size !== file.size ||
                        item.lastModified !== file.lastModified
                    )
                  )
                }
                isSubmitting={brief.isStreaming || upload.isPending}
                pendingLabel={upload.isPending ? 'Uploading...' : 'Generating...'}
                submitLabel="Send"
                placeholder={
                  canGenerate
                    ? "Reply 'yes' to generate, ask a follow-up question, or attach more records..."
                    : 'Add more context, attach records, or wait while the case is being prepared...'
                }
                disabled={brief.isStreaming || upload.isPending}
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="rounded-2xl"
                  disabled={!canGenerate}
                  onClick={() => startBrief()}
                >
                  {brief.isStreaming ? 'Generating...' : 'Generate Expert Research'}
                </Button>
                {!canGenerate && data.status === 'generating_brief' && (
                  <span className="text-xs text-neutral-500">
                    A brief is already running. Hold tight while it finishes.
                  </span>
                )}
              </div>

              {(actionError || brief.error || upload.error || updateProfile.error) && (
                <p className="text-sm text-red-600 dark:text-red-400">
                  {actionError ||
                    brief.error ||
                    upload.error?.message ||
                    updateProfile.error?.message}
                </p>
              )}
            </div>
          </section>
        </BorderBeam>
      </main>
    </div>
  );
}
