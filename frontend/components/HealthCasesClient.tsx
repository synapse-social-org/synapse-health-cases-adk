'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BorderBeam } from 'border-beam';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useQueryState } from 'nuqs';
import z from 'zod';
import AnimatedDots from '@/app/components/AnimatedDots';
import Button from '@/app/components/Button';
import PageSkeleton from '@/app/components/PageSkeleton';
import SplashLogoOrb from '@/app/components/SplashLogoOrb';
import SynapseIcon from '@/app/components/icons/SynapseIcon';
import {
  BookIcon,
  GoogleIcon,
  MicrophoneIcon,
  NetworkIcon,
  QuoteIcon,
  SparkleIcon,
} from '@/app/components/icons';
import { useShellChrome } from '@/app/components/ShellChromeContext';
import { useSpeechDictation } from '@/app/hooks/useSpeechDictation';
import { usePaper } from '@synapse/lib/client';
import { feedPhraseToId, UserDataSchema } from '@synapse/lib';
import {
  BriefProgressMetadata,
  BriefToolEvent,
  HealthCase,
  HealthCaseCitationGrounding,
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
  useUpdateHealthCaseDigest,
  useUpdateHealthCaseProfile,
  useUploadHealthCaseDocument,
} from '@/app/hooks/useHealthCases';
import { parseBrief, safeFilename } from './briefPdf';
import BriefProgress from './BriefProgress';
import { BriefFinishedActions, briefHasStructuredSections } from './BriefFinishedActions';
import { MarkdownContent } from '@/app/components/markdown/MarkdownContent';
import { authFetch } from '@/lib/authUtils';
import { safeHref } from '@/lib/safeHref';
import HealthCaseVoiceAgent from './HealthCaseVoiceAgent';

const emptyProfile: HealthCaseProfile = {
  demographics: {},
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
  phenotypes: [],
  organ_age_flags: [],
  structured_conditions: [],
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

function BriefCitedPaperThumbnail({
  paperId,
  fallbackTitle,
  onResolve,
}: {
  paperId: string;
  fallbackTitle?: string;
  onResolve: (id: string, hasAbstract: boolean) => void;
}) {
  const { data: paper } = usePaper(paperId);
  const url =
    paper && 'graphical_abstract_url' in paper
      ? ((paper as { graphical_abstract_url?: string }).graphical_abstract_url ?? undefined)
      : undefined;
  const title =
    (paper && 'title' in paper ? (paper as { title?: string }).title : undefined) ||
    fallbackTitle ||
    'Cited paper';

  useEffect(() => {
    if (paper) onResolve(paperId, Boolean(url));
  }, [paper, url, paperId, onResolve]);

  if (!url) return null;

  return (
    <Link href={`/papers/${paperId}`} className="group block w-[150px] shrink-0" title={title}>
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white transition group-hover:border-sky-300 dark:border-neutral-800 dark:bg-neutral-900 dark:group-hover:border-sky-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`Graphical abstract: ${title}`}
          loading="lazy"
          className="h-[110px] w-full object-cover"
        />
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-4 text-neutral-600 dark:text-neutral-300">
        {title}
      </p>
    </Link>
  );
}

/**
 * Renders graphical-abstract thumbnails for the brief's cited papers. Cited
 * papers (`brief.sources` / `papers_cited`) only carry `{ title, id }`, so each
 * thumbnail fetches the paper via `usePaper` to obtain `graphical_abstract_url`.
 * Papers without an id (e.g. web-search citations) or without an abstract are
 * skipped; the section disappears entirely when none qualify.
 */
function BriefCitedPapers({ sources }: { sources?: Array<Record<string, unknown>> }) {
  const cited = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; title?: string }> = [];
    for (const source of sources || []) {
      const id = typeof source.id === 'string' ? source.id : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: typeof source.title === 'string' ? source.title : undefined });
    }
    return out.slice(0, 8);
  }, [sources]);

  const [abstractById, setAbstractById] = useState<Record<string, boolean>>({});
  const handleResolve = useCallback((id: string, hasAbstract: boolean) => {
    setAbstractById((prev) => (prev[id] === hasAbstract ? prev : { ...prev, [id]: hasAbstract }));
  }, []);
  const anyAbstract = Object.values(abstractById).some(Boolean);

  if (cited.length === 0) return null;

  return (
    <div className={anyAbstract ? 'mt-4' : ''}>
      {anyAbstract && (
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Visual abstracts
        </p>
      )}
      <div className={anyAbstract ? 'mt-2 flex gap-3 overflow-x-auto pb-1' : 'flex'}>
        {cited.map((paper) => (
          <BriefCitedPaperThumbnail
            key={paper.id}
            paperId={paper.id}
            fallbackTitle={paper.title}
            onResolve={handleResolve}
          />
        ))}
      </div>
    </div>
  );
}

/** Active shimmer placeholder shown while a brief streams in but has no text yet. */
function BriefGeneratingPlaceholder() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="mt-3">
      <p className="text-sm text-neutral-500">
        Synapse is reading evidence, talking to its tools, and pulling citations. This usually takes
        ~30s
        <AnimatedDots />
      </p>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <motion.div
            key={index}
            className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
            animate={reduceMotion ? undefined : { opacity: [0.5, 1, 0.5] }}
            transition={{
              duration: 1.6,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: reduceMotion ? 0 : index * 0.2,
            }}
          >
            <div className="h-3 w-24 rounded-full bg-sky-100 dark:bg-sky-950/40" />
            <div className="mt-3 h-3 w-11/12 rounded-full bg-neutral-200 dark:bg-neutral-800" />
            <div className="mt-2 h-3 w-3/4 rounded-full bg-neutral-200 dark:bg-neutral-800" />
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/**
 * Surfaces the post-generation hallucination guard. When the agent's prose
 * references trial NCT IDs or acronyms that could not be matched against the
 * retrieved evidence, we flag them here rather than silently trusting the
 * text — honest "we could not verify these" beats false confidence.
 */
function UnverifiedReferencesNotice({
  grounding,
}: {
  grounding?: HealthCaseCitationGrounding | null;
}) {
  const ncts = grounding?.unverified_ncts ?? [];
  const acronyms = grounding?.unverified_acronyms ?? [];
  if (ncts.length === 0 && acronyms.length === 0) return null;

  const items = [...ncts, ...acronyms];
  return (
    <div
      role="note"
      aria-label="Unverified references"
      className="mt-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <p className="font-semibold">References we could not verify</p>
      <p className="mt-1 leading-6">
        These trials or studies are mentioned in the brief but did not match a source we retrieved.
        Confirm them against the primary source before relying on them:{' '}
        <span className="font-medium">{items.join(', ')}</span>.
      </p>
    </div>
  );
}

function ExpertResearchBrief({
  caseId,
  content,
  researchers,
  clinicalTrials,
  feedSuggestions,
  sources,
  citationGrounding,
}: {
  caseId: string;
  content: string;
  researchers?: HealthCaseResearcher[];
  clinicalTrials?: HealthCaseClinicalTrial[];
  feedSuggestions?: HealthCaseFeedSuggestion[];
  sources?: Array<Record<string, unknown>>;
  citationGrounding?: HealthCaseCitationGrounding | null;
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
                <>
                  <BriefCitedPapers sources={sources} />
                  <UnverifiedReferencesNotice grounding={citationGrounding} />
                  <StructuredFeedSuggestions suggestions={feedSuggestions} />
                </>
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

const HEALTH_CASE_INTAKE_ANIMATED_QUERIES = [
  'Recent HFpEF diagnosis with worsening shortness of breath — what therapies and trials matter?',
  'Second opinion on atrial fibrillation treatment options with every claim cited',
  'Summarize labs, imaging reports, current meds, and unanswered clinical questions',
  'Find relevant researchers, expert perspectives, and active clinical trials near me',
];

const INTAKE_TYPE_SPEED = 55;
const INTAKE_DELETE_SPEED = 25;
const INTAKE_PAUSE_AFTER_TYPE = 2200;
const INTAKE_PAUSE_AFTER_DELETE = 400;

const INTAKE_PROGRESS_PHRASES = [
  'Analyzing your input',
  'Evaluating questions to ask',
  'Checking attached records',
  'Structuring the case profile',
  'Preparing the case summary',
] as const;

const BRIEF_PROGRESS_PHRASES = [
  'Planning which sources to consult',
  'Gathering peer-reviewed evidence',
  'Checking clinical trials and guidelines',
  'Synthesizing the cited brief',
] as const;

const INTAKE_PROGRESS_CYCLE_MS = 2800;

function useCyclingPhrase(
  phrases: readonly string[],
  active: boolean,
  intervalMs = INTAKE_PROGRESS_CYCLE_MS
): string {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || reduceMotion) {
      setIndex(0);
      return;
    }
    setIndex(0);
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % phrases.length);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs, phrases.length, reduceMotion]);

  if (!active) return phrases[0];
  return reduceMotion ? phrases[0] : phrases[index % phrases.length];
}

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
  animatedQueries,
  variant = 'default',
  embedded = false,
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
  animatedQueries?: string[];
  variant?: 'default' | 'intake';
  /** Renders inside the chat thread (no outer BorderBeam). */
  embedded?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const isIntake = variant === 'intake';
  const [isFocused, setIsFocused] = useState(false);
  const [animatedText, setAnimatedText] = useState('');
  const [isAnimating, setIsAnimating] = useState(
    () => Boolean(animatedQueries?.length) && !reduceMotion
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const animationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryIndexRef = useRef(0);

  // Voice dictation: finalized speech segments are appended to the draft. We
  // track the latest draft in a ref so rapid-fire `onresult` callbacks never
  // drop a segment by closing over a stale value.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const appendTranscript = useCallback(
    (text: string) => {
      const previous = draftRef.current;
      const needsSpace = previous.length > 0 && !/\s$/.test(previous);
      const next = `${previous}${needsSpace ? ' ' : ''}${text}`;
      draftRef.current = next;
      setDraft(next);
    },
    [setDraft]
  );
  const dictation = useSpeechDictation({ onFinalTranscript: appendTranscript });
  const voiceDisabled = disabled || isSubmitting;
  useEffect(() => {
    if (voiceDisabled && dictation.isListening) dictation.stop();
  }, [voiceDisabled, dictation.isListening, dictation.stop]);

  const stopAnimation = useCallback(() => {
    setIsAnimating(false);
    if (animationRef.current) {
      clearTimeout(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!animatedQueries?.length || reduceMotion) {
      stopAnimation();
      return;
    }
    if (!isAnimating) return;

    let cancelled = false;
    let currentIndex = queryIndexRef.current;

    const animate = async () => {
      while (!cancelled) {
        const targetQuery = animatedQueries[currentIndex % animatedQueries.length];

        for (let i = 0; i <= targetQuery.length; i++) {
          if (cancelled) return;
          setAnimatedText(targetQuery.slice(0, i));
          await new Promise<void>((resolve) => {
            animationRef.current = setTimeout(resolve, INTAKE_TYPE_SPEED);
          });
        }

        if (cancelled) return;
        await new Promise<void>((resolve) => {
          animationRef.current = setTimeout(resolve, INTAKE_PAUSE_AFTER_TYPE);
        });

        for (let i = targetQuery.length; i >= 0; i--) {
          if (cancelled) return;
          setAnimatedText(targetQuery.slice(0, i));
          await new Promise<void>((resolve) => {
            animationRef.current = setTimeout(resolve, INTAKE_DELETE_SPEED);
          });
        }

        if (cancelled) return;
        await new Promise<void>((resolve) => {
          animationRef.current = setTimeout(resolve, INTAKE_PAUSE_AFTER_DELETE);
        });

        currentIndex++;
        queryIndexRef.current = currentIndex;
      }
    };

    animate();

    return () => {
      cancelled = true;
      if (animationRef.current) clearTimeout(animationRef.current);
    };
  }, [animatedQueries, isAnimating, reduceMotion, stopAnimation]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, isIntake ? 160 : 120)}px`;
  }, [draft, isIntake]);

  const canSubmit = !disabled && !isSubmitting && (draft.trim().length > 0 || files.length > 0);
  const showAnimatedPlaceholder =
    Boolean(animatedQueries?.length) && !isFocused && !draft.trim() && isAnimating && !files.length;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (dictation.isListening) dictation.stop();
    if (!canSubmit) return;
    onSubmit();
  };

  const formShell = (
    <form
      onSubmit={handleSubmit}
      className={`bg-white/95 backdrop-blur-xl dark:bg-neutral-950/95 ${
        embedded
          ? 'rounded-2xl p-2.5 ring-0'
          : `rounded-[30px] ${
              isIntake
                ? 'p-4 shadow-[0_24px_90px_rgba(2,24,44,0.14)] ring-1 ring-sky-200/60 dark:ring-sky-500/20'
                : 'p-3 shadow-[0_18px_70px_rgba(2,24,44,0.1)]'
            }`
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="relative min-w-0 flex-1">
          {showAnimatedPlaceholder && (
            <div
              className="pointer-events-none absolute inset-0 z-[1] rounded-2xl px-4 py-3.5 md:py-4"
              aria-hidden
            >
              <span
                className={`text-neutral-400 dark:text-neutral-500 ${
                  isIntake ? 'text-[15px] leading-6 md:text-base' : 'text-sm'
                }`}
              >
                {animatedText}
                <span className="ml-0.5 inline-block h-5 w-0.5 animate-pulse bg-neutral-400 align-middle dark:bg-neutral-500" />
              </span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (isAnimating) stopAnimation();
            }}
            onFocus={() => {
              setIsFocused(true);
              stopAnimation();
              setAnimatedText('');
            }}
            onBlur={() => {
              setIsFocused(false);
              if (!draft.trim() && animatedQueries?.length && !reduceMotion) {
                setIsAnimating(true);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
            placeholder={showAnimatedPlaceholder ? '' : placeholder}
            className={`relative z-[2] w-full min-w-0 cursor-text resize-none rounded-2xl border border-neutral-200 bg-neutral-50 text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-sky-400 focus:bg-white focus:ring-4 focus:ring-sky-100/80 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:placeholder:text-neutral-500 dark:focus:border-sky-500 dark:focus:ring-sky-950/60 ${
              isIntake
                ? 'min-h-[88px] px-4 py-3.5 text-[15px] leading-6 md:min-h-[96px] md:py-4 md:text-base'
                : 'min-h-16 px-4 py-3 text-sm focus:ring-2'
            }`}
            data-posthog-mask
            aria-label="Message"
          />
        </div>
        <div className="flex w-full items-center gap-2 sm:mt-1 sm:w-auto">
          {dictation.isSupported && (
            <button
              type="button"
              onClick={() => dictation.toggle()}
              disabled={voiceDisabled}
              aria-pressed={dictation.isListening}
              aria-label={dictation.isListening ? 'Stop voice input' : 'Start voice input'}
              title={dictation.isListening ? 'Stop voice input' : 'Dictate with your voice'}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isIntake ? 'md:h-12 md:w-12' : ''
              } ${
                dictation.isListening
                  ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:border-sky-300 hover:text-sky-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-sky-800 dark:hover:text-sky-300'
              }`}
            >
              <MicrophoneIcon
                className={`h-5 w-5 ${dictation.isListening ? 'motion-safe:animate-pulse' : ''}`}
                isFilled={dictation.isListening}
              />
            </button>
          )}
          <Button
            type="submit"
            className={`h-11 flex-1 rounded-2xl sm:w-auto ${
              isIntake ? 'sm:min-w-28 md:h-12' : 'sm:min-w-24'
            }`}
            disabled={!canSubmit}
          >
            {isSubmitting ? pendingLabel : submitLabel}
          </Button>
        </div>
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
        <p
          className={`text-xs ${
            dictation.error
              ? 'text-red-600 dark:text-red-400'
              : dictation.isListening
                ? 'text-red-600 dark:text-red-300'
                : 'text-neutral-500 dark:text-neutral-400'
          }`}
          aria-live="polite"
          data-posthog-mask
        >
          {dictation.error
            ? dictation.error
            : dictation.isListening
              ? dictation.interimTranscript.trim() || 'Listening… tap the mic to stop'
              : (helperText ?? 'Press Enter to send · Shift + Enter for a new line')}
        </p>
      </div>
    </form>
  );

  if (embedded) {
    return <div className="w-full">{formShell}</div>;
  }

  return (
    <BorderBeam size="md" duration={8} colorVariant="ocean" theme="auto" className="w-full">
      {formShell}
    </BorderBeam>
  );
}

function CreateCaseCard({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const intakeCase = useHealthCaseIntake();
  const createCase = useCreateHealthCase();
  const updateProfile = useUpdateHealthCaseProfile();
  const uploadDocuments = useUploadHealthCaseDocument();
  const [messages, setMessages] = useState<IntakeMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [allFiles, setAllFiles] = useState<File[]>([]);
  const [intake, setIntake] = useState<HealthCaseIntake | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');
  const [actionError, setActionError] = useState('');
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
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

  // Keep the latest turn visible by scrolling only the chat container — never
  // the window. `scrollIntoView` bubbles to every scrollable ancestor and was
  // yanking the whole page back to the top on each send.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
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

  const showConversation = messages.length > 0 || intakeCase.isPending || Boolean(intake);
  const intakeProgressPhrase = useCyclingPhrase(INTAKE_PROGRESS_PHRASES, intakeCase.isPending);

  // Once the conversation starts, the dashboard collapses its marketing
  // sections so the chat takes over the full page (Perplexity-style).
  useEffect(() => {
    onActiveChange?.(showConversation);
  }, [showConversation, onActiveChange]);

  const intakeComposer = (
    <ChatComposer
      variant="intake"
      embedded={showConversation}
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
      pendingLabel={intakeCase.isPending ? intakeProgressPhrase : 'Send'}
      submitLabel="Send"
      animatedQueries={showConversation || intake ? undefined : HEALTH_CASE_INTAKE_ANIMATED_QUERIES}
      placeholder={
        intake
          ? 'Reply yes to confirm, or add more context to refine the summary'
          : "Describe your health case — who's it for, what's happened, and what you're deciding"
      }
    />
  );

  return (
    <BorderBeam size="md" duration={9} colorVariant="ocean" theme="auto" className="w-full">
      <motion.section
        className="relative overflow-hidden rounded-[36px] synapse-glass-strong"
        initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 360, damping: 34 }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(78,157,252,0.18),transparent_28rem),radial-gradient(circle_at_80%_10%,rgba(129,140,248,0.14),transparent_24rem)]" />
        <div className="relative px-5 pt-5 md:px-8 md:pt-7">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-light)] text-[var(--accent)] shadow-sm">
                <SynapseIcon className="h-5 w-5" isFilled />
              </div>
              <div>
                <p className="text-sm font-semibold text-sky-700 dark:text-sky-300">
                  Synapse Intake Agent
                </p>
                <h2 className="text-2xl font-bold tracking-tight text-neutral-950 dark:text-white md:text-3xl">
                  Chat through the case.
                </h2>
              </div>
            </div>
            <div className="rounded-2xl border border-white/70 bg-white/55 px-4 py-2.5 text-xs text-neutral-600 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-300 sm:max-w-[220px]">
              Private intake · PDF-aware · confirm before saving
            </div>
          </div>

          {!showConversation && (
            <div className="mt-5 space-y-4 md:mt-6">
              <HealthCaseVoiceAgent />
              {intakeComposer}
            </div>
          )}
        </div>

        <div className="relative space-y-5 px-4 pb-4 pt-5 md:px-6 md:pb-6 md:pt-6 lg:px-8 lg:pb-8">
          {showConversation && (
            <div className="flex h-[calc(100svh-14rem)] min-h-[380px] flex-col overflow-hidden rounded-[30px] border border-white/70 bg-white/45 shadow-inner md:h-[calc(100svh-13rem)] dark:border-white/[0.06] dark:bg-black/10">
              <div
                ref={messagesContainerRef}
                className="min-h-[120px] flex-1 space-y-5 overflow-y-auto p-4 pr-2 md:p-6"
              >
                {messages.map((message) => (
                  <ChatBubble
                    key={message.id}
                    role={message.role}
                    content={message.content}
                    attachments={message.attachments}
                  />
                ))}
                {intakeCase.isPending && (
                  <IntakeProgressBubble
                    label={intakeProgressPhrase}
                    hasRecords={allFiles.length > 0 || files.length > 0}
                  />
                )}
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
              </div>
              <div className="shrink-0 border-t border-white/70 bg-white/75 p-3 backdrop-blur-md dark:border-white/[0.06] dark:bg-neutral-950/80 md:p-4">
                <div className="mb-3">
                  <HealthCaseVoiceAgent />
                </div>
                {intakeComposer}
              </div>
            </div>
          )}

          {!showConversation && (
            <div className="rounded-[28px] border border-white/70 bg-white/40 p-5 dark:border-white/[0.06] dark:bg-white/[0.03] md:p-6">
              <p className="max-w-3xl text-sm leading-7 text-neutral-600 dark:text-neutral-300">
                Let&rsquo;s build the Health Case together. Tell us who this is for, what has
                happened so far, and what decision you&rsquo;re trying to make. Attach records when
                they help &mdash; labs, imaging reports, discharge summaries. When the summary looks
                right, reply &ldquo;yes&rdquo; and we&rsquo;ll generate your Expert Research brief
                and weekly digest.
              </p>

              <div className="mt-6 border-t border-black/5 pt-6 dark:border-white/[0.07]">
                <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                  Clinically grounded intake
                </p>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                  The questions Synapse asks aren&rsquo;t guesses. They&rsquo;re the same ones a
                  cardiologist, nephrologist, or hepatologist would ask in a specialist visit
                  &mdash; brought to you before, between, or without one.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      title: 'Guideline-anchored questions',
                      body: 'Each follow-up traces to a current guideline — ACC/AHA, KDIGO, ACOG/ESC — not model intuition. Auditable, not a black box.',
                    },
                    {
                      title: 'Trajectory & organ-system axes',
                      body: 'We capture how labs change over time and across the heart, kidney, liver, and metabolic axes — structured fields, grounded in your own results.',
                    },
                    {
                      title: 'Sex-specific reference ranges',
                      body: 'Lab values are read against the correct female or male reference range, so what counts as “normal” is right for you.',
                    },
                  ].map((item) => (
                    <div
                      key={item.title}
                      className="rounded-2xl border border-white/70 bg-white/55 p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]"
                    >
                      <p className="text-sm font-semibold text-neutral-900 dark:text-white">
                        {item.title}
                      </p>
                      <p className="mt-1.5 text-xs leading-5 text-neutral-600 dark:text-neutral-300">
                        {item.body}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
                  This helps you target the right research and prepare for care. It is research
                  education, not diagnosis or medical advice.
                </p>
              </div>
            </div>
          )}

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
          {!showConversation && (
            <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
              Educational research only — not a diagnosis or medical advice. Records are encrypted
              and only used for your case.
            </p>
          )}
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
            ? 'min-w-0 max-w-[88%] flex-1 break-words'
            : `min-w-0 max-w-[88%] break-words rounded-3xl p-4 text-sm shadow-sm ${
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

function GeminiAvatar({ pulsing = false }: { pulsing?: boolean }) {
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white shadow-[0_8px_24px_rgba(2,24,44,0.12)] ring-1 ring-indigo-100 dark:bg-neutral-900 dark:ring-indigo-900/50 ${
        pulsing ? 'motion-safe:animate-pulse' : ''
      }`}
    >
      <GoogleIcon className="h-5 w-5" aria-hidden />
    </div>
  );
}

function IntakeProgressBubble({ label, hasRecords }: { label: string; hasRecords?: boolean }) {
  return (
    <div
      className="flex gap-3"
      role="status"
      aria-busy="true"
      aria-label="Synapse is processing your intake"
    >
      <GeminiAvatar pulsing />
      <div className="min-w-0 flex-1 rounded-3xl rounded-tl-md border border-indigo-100 bg-gradient-to-br from-white via-indigo-50/80 to-sky-50/60 p-4 text-sm shadow-sm dark:border-indigo-900/40 dark:from-neutral-900 dark:via-indigo-950/30 dark:to-sky-950/20">
        <p className="font-medium text-neutral-800 dark:text-neutral-100" aria-hidden="true">
          {label}
          <AnimatedDots />
        </p>
        {hasRecords && (
          <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400" aria-hidden="true">
            Extracting and reviewing uploaded records
          </p>
        )}
      </div>
    </div>
  );
}

function ChatTypingBubble({
  label,
  useGemini = false,
  detail,
}: {
  label: string;
  useGemini?: boolean;
  detail?: string;
}) {
  return (
    <div
      className="flex gap-3"
      role="status"
      aria-busy="true"
      aria-label={detail ? `${label}. ${detail}` : label}
    >
      {useGemini ? (
        <GeminiAvatar pulsing />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#02182c] text-white shadow-[0_8px_24px_rgba(2,24,44,0.22)] dark:bg-white dark:text-neutral-950">
          <SynapseIcon className="h-4 w-4" isFilled />
        </div>
      )}
      <div className="rounded-3xl rounded-tl-md border border-neutral-200 bg-white p-4 text-sm text-neutral-500 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <p aria-hidden="true">
          {label}
          <AnimatedDots />
        </p>
        {detail && (
          <p className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">{detail}</p>
        )}
      </div>
    </div>
  );
}

function ChevronRightGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M7.5 5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Makes a Health Cases surface immersive: collapses the global desktop sidebar
 * on mount and restores it on unmount, so other routes are untouched. Called at
 * the top of a page component (before any early returns) to avoid a flash of
 * the expanded sidebar while data loads.
 */
function useImmersiveSidebar() {
  const { setSidebarCollapsed } = useShellChrome();
  useEffect(() => {
    setSidebarCollapsed(true);
    return () => setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);
}

/** Left-edge handle that brings the collapsed sidebar back (desktop only). */
function SidebarRestoreHandle() {
  const { sidebarCollapsed, setSidebarCollapsed } = useShellChrome();
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {sidebarCollapsed && (
        <motion.button
          type="button"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Show navigation sidebar"
          className="synapse-glass-strong fixed left-0 top-1/2 z-40 hidden -translate-y-1/2 items-center gap-1.5 rounded-r-2xl border border-l-0 border-black/5 py-3 pl-2 pr-2.5 text-neutral-600 shadow-md transition-colors hover:text-neutral-950 md:flex dark:border-white/10 dark:text-neutral-300 dark:hover:text-white"
          initial={reduceMotion ? false : { x: -24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { x: -24, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        >
          <SynapseIcon className="h-5 w-5" isFilled />
          <ChevronRightGlyph className="h-4 w-4" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

const HEALTH_CASE_VALUE_ITEMS: Array<{
  icon: React.ComponentType<{ className?: string; isFilled?: boolean }>;
  title: string;
  description: string;
}> = [
  {
    icon: QuoteIcon,
    title: 'What experts are saying',
    description: 'Synthesized consensus from guidelines, editorials, and clinician discourse.',
  },
  {
    icon: NetworkIcon,
    title: 'Who is working on it',
    description: 'Relevant researchers and centers, with the rationale for each match.',
  },
  {
    icon: SparkleIcon,
    title: 'Clinical trials',
    description: 'Active trials that fit the case, with phase, status, and why they fit.',
  },
  {
    icon: BookIcon,
    title: 'The latest papers',
    description: 'Recent research surfaced and summarized — every claim cited.',
  },
];

function HealthCaseValueStrip() {
  const reduceMotion = useReducedMotion();
  return (
    <section aria-label="What Synapse brings back" className="w-full">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {HEALTH_CASE_VALUE_ITEMS.map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.title}
              className="synapse-card flex h-full flex-col gap-3 rounded-3xl p-5"
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.4, delay: reduceMotion ? 0 : index * 0.07 }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-light)] text-[var(--accent)]">
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-neutral-950 dark:text-white">
                  {item.title}
                </p>
                <p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
                  {item.description}
                </p>
              </div>
            </motion.div>
          );
        })}
      </div>
      <p className="mx-auto mt-4 max-w-3xl text-center text-xs leading-6 text-neutral-500 dark:text-neutral-400">
        Behind the scenes, a multi-agent research team splits evidence, trial, and researcher
        discovery before synthesizing the brief. While we&rsquo;re in beta we focus on cardiology
        cases.
      </p>
    </section>
  );
}

const HEALTH_CASE_GROUNDING_POINTS: Array<{ title: string; description: string }> = [
  {
    title: 'Grounded in real evidence',
    description:
      'A multi-agent research team queries 600,000+ peer-reviewed cardiology papers, ACC/AHA/ESC guidelines, and ClinicalTrials.gov in real time. The model is instructed to use tools, not answer from memory.',
  },
  {
    title: 'Every claim cited',
    description:
      'Each clinical or quantitative statement is tied to a specific paper, trial (NCT ID), or guideline — and the cited sources are shown right alongside the brief.',
  },
  {
    title: 'Automatic citation checks',
    description:
      "After drafting, we verify referenced trials and studies against our databases and flag any reference we can't confirm, instead of presenting it as fact.",
  },
  {
    title: 'Built from your case',
    description:
      'Briefs are generated from the profile you review and confirm plus your uploaded records, which stay encrypted and are used only for your case.',
  },
];

/**
 * Public-facing explainer for how Health Cases minimizes hallucination and
 * keeps outputs cited. Copy is intentionally constrained to what the pipeline
 * actually does (tool-grounded retrieval, inline citations, post-hoc citation
 * verification) so marketing stays truthful to the implementation.
 */
function HealthCaseGroundingSection() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      aria-label="How we keep it grounded and cited"
      className="synapse-card rounded-[28px] p-6 md:p-8"
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.4 }}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
        Quality &amp; trust
      </p>
      <h2 className="mt-1 text-2xl font-semibold text-neutral-950 dark:text-white">
        How we keep it grounded and cited
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-7 text-neutral-600 dark:text-neutral-300">
        Synapse is built to minimize hallucination. Briefs draw on retrieved evidence, cite their
        sources, and are checked for unverifiable references before you read them.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {HEALTH_CASE_GROUNDING_POINTS.map((point) => (
          <div
            key={point.title}
            className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-sm font-semibold text-neutral-950 dark:text-white">{point.title}</p>
            <p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
              {point.description}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-5 text-xs leading-6 text-neutral-500 dark:text-neutral-400">
        Educational research only — not a diagnosis or medical advice. Always confirm against the
        primary source and your clinical team before acting on anything in a brief.
      </p>
    </motion.section>
  );
}

function CaseListSkeleton() {
  const reduceMotion = useReducedMotion();
  return (
    <>
      {Array.from({ length: 2 }).map((_, index) => (
        <motion.div
          key={index}
          className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800"
          animate={reduceMotion ? undefined : { opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <div className="h-4 w-2/3 rounded-full bg-neutral-200 dark:bg-neutral-800" />
          <div className="mt-3 h-3 w-1/2 rounded-full bg-neutral-200 dark:bg-neutral-800" />
        </motion.div>
      ))}
    </>
  );
}

export function HealthCasesDashboard() {
  const { data, isLoading, error } = useHealthCases();
  const reduceMotion = useReducedMotion();
  const [chatActive, setChatActive] = useState(false);
  useImmersiveSidebar();

  return (
    <div className="min-h-screen">
      <SidebarRestoreHandle />
      <main
        className={
          chatActive
            ? 'mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-4 pt-4 md:px-8'
            : 'mx-auto flex w-full max-w-[1400px] flex-col gap-8 p-4 py-8 md:p-8 lg:py-10'
        }
      >
        <motion.section
          className={`mx-auto flex w-full max-w-4xl flex-col items-center text-center ${
            chatActive ? 'hidden' : ''
          }`}
          initial={reduceMotion ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <SplashLogoOrb className="mb-5" />
          <BetaCardiologyPill />
          <h1 className="mx-auto mt-4 max-w-3xl text-4xl font-bold tracking-tight text-neutral-950 dark:text-white md:text-6xl">
            The latest research in your hands.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-neutral-600 dark:text-neutral-300 md:text-lg">
            Describe your health case - Synapse keeps you updated with the latest research, expert
            perspectives, clinical trials and therapies.
          </p>
        </motion.section>

        <CreateCaseCard onActiveChange={setChatActive} />

        <div className={chatActive ? 'hidden' : ''}>
          <HealthCaseValueStrip />
        </div>

        <div className={chatActive ? 'hidden' : ''}>
          <HealthCaseGroundingSection />
        </div>

        <section className={`synapse-card rounded-[28px] p-6 ${chatActive ? 'hidden' : ''}`}>
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
          {error && <p className="mt-4 text-sm text-red-600">{error.message}</p>}
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {isLoading && <CaseListSkeleton />}
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
      sources?: Array<Record<string, unknown>>;
      citationGrounding?: HealthCaseCitationGrounding | null;
      toolEvents?: BriefToolEvent[];
      thinking?: string;
      activeTool?: string | null;
      progressMeta?: BriefProgressMetadata | null;
      startedAtMs?: number | null;
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
  const demographics = profile.demographics || {};
  if (demographics.sex || demographics.age) {
    const parts: string[] = [];
    if (demographics.sex) parts.push(String(demographics.sex));
    if (demographics.age) parts.push(`age ${demographics.age}`);
    lines.push(`\n**Patient:** ${parts.join(', ')}`);
  }
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
  if ((profile.structured_conditions || []).length > 0) {
    const structured = (profile.structured_conditions || [])
      .map((item) => {
        const icd = (item.icd10_codes || []).join(', ');
        const grade = item.severity_grade ? ` · ${item.severity_grade}` : '';
        const icdLabel = icd ? ` (${icd})` : '';
        return `- ${item.canonical_name}${icdLabel}${grade}`;
      })
      .join('\n');
    lines.push(
      `\n**Structured conditions** (dictionary normalization, not a diagnosis):\n${structured}`
    );
  }
  if ((profile.phenotypes || []).length > 0) {
    const subgroups = (profile.phenotypes || [])
      .map((item) => {
        const confidence = item.confidence ? ` _(${item.confidence} confidence)_` : '';
        return `- ${item.label}${confidence}`;
      })
      .join('\n');
    lines.push(`\n**Likely subgroups** (hypotheses for research, not a diagnosis):\n${subgroups}`);
  }
  if ((profile.organ_age_flags || []).length > 0) {
    const flags = (profile.organ_age_flags || [])
      .map((item) => `- ${item.organ}: appears older than chronological age`)
      .join('\n');
    lines.push(`\n**Organ-age signals** (hypotheses for research, not a diagnosis):\n${flags}`);
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
  // Sex drives selection of the correct sex-specific lab reference range, so it
  // is editable here; age refines age-banded references.
  const [sex, setSex] = useState(initial.demographics?.sex || '');
  const [age, setAge] = useState(
    initial.demographics?.age != null ? String(initial.demographics.age) : ''
  );
  // Structured hypotheses are not free-text editable here; the user can keep or
  // remove them. They must be preserved on save or the spread of `emptyProfile`
  // (which has empty arrays) would wipe the intake-detected subgroups.
  const [phenotypes, setPhenotypes] = useState(initial.phenotypes || []);
  const [organAgeFlags, setOrganAgeFlags] = useState(initial.organ_age_flags || []);
  const [structuredConditions, setStructuredConditions] = useState(
    initial.structured_conditions || []
  );

  const save = async () => {
    const demographics: HealthCaseProfile['demographics'] = {};
    if (sex.trim()) demographics.sex = sex.trim();
    const parsedAge = parseInt(age, 10);
    if (!Number.isNaN(parsedAge) && parsedAge > 0 && parsedAge < 130) {
      demographics.age = parsedAge;
    }
    await updateProfile.mutateAsync({
      ...emptyProfile,
      demographics,
      conditions: splitLines(conditions),
      symptoms: splitLines(symptoms),
      medications: splitLines(medications),
      procedures: splitLines(procedures),
      goals: splitLines(goals),
      questions: splitLines(questions),
      notes,
      phenotypes,
      organ_age_flags: organAgeFlags,
      structured_conditions: structuredConditions,
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
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Sex (for lab reference ranges)
          </span>
          <select
            value={sex}
            onChange={(event) => setSex(event.target.value)}
            className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
          >
            <option value="">Not specified</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="intersex">Intersex</option>
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Age</span>
          <input
            type="number"
            min={0}
            max={129}
            value={age}
            onChange={(event) => setAge(event.target.value)}
            className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
            data-posthog-mask
          />
        </label>
      </div>
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
      {(structuredConditions.length > 0 || phenotypes.length > 0 || organAgeFlags.length > 0) && (
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Structured conditions, subgroups &amp; organ-age signals
            </p>
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
              Dictionary normalization and research hypotheses — not a diagnosis. Remove any that
              don&rsquo;t fit.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {structuredConditions.map((item, index) => (
              <div
                key={`structured-${index}`}
                className="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-white">
                    {item.canonical_name}
                    {(item.icd10_codes || []).length > 0 ? (
                      <span className="ml-1 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                        ({(item.icd10_codes || []).join(', ')})
                      </span>
                    ) : null}
                  </p>
                  {item.severity_grade ? (
                    <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                      Grade: {item.severity_grade}
                    </p>
                  ) : null}
                  {(item.signals || []).length > 0 ? (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      Based on: {(item.signals || []).join('; ')}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setStructuredConditions((prev) => prev.filter((_, i) => i !== index))
                  }
                  className="shrink-0 text-xs font-medium text-neutral-500 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            ))}
            {phenotypes.map((item, index) => (
              <div
                key={`phenotype-${index}`}
                className="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-white">
                    {item.label}
                    {item.confidence ? (
                      <span className="ml-1 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                        ({item.confidence} confidence)
                      </span>
                    ) : null}
                  </p>
                  {item.rationale ? (
                    <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                      {item.rationale}
                    </p>
                  ) : null}
                  {(item.signals || []).length > 0 ? (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      Based on: {(item.signals || []).join('; ')}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setPhenotypes((prev) => prev.filter((_, i) => i !== index))}
                  className="shrink-0 text-xs font-medium text-neutral-500 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            ))}
            {organAgeFlags.map((item, index) => (
              <div
                key={`organ-age-${index}`}
                className="flex items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-white">
                    {item.organ}: appears older than chronological age
                  </p>
                  {item.rationale ? (
                    <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                      {item.rationale}
                    </p>
                  ) : null}
                  {(item.signals || []).length > 0 ? (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      Based on: {(item.signals || []).join('; ')}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOrganAgeFlags((prev) => prev.filter((_, i) => i !== index))}
                  className="shrink-0 text-xs font-medium text-neutral-500 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
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

function DigestSubscribeCard({ healthCase }: { healthCase: HealthCase }) {
  const updateDigest = useUpdateHealthCaseDigest(healthCase.id);
  const enabled = Boolean(healthCase.digest_enabled);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const subscribe = async () => {
    setError('');
    try {
      await updateDigest.mutateAsync({
        enabled: true,
        email: email.trim() || undefined,
      });
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not subscribe');
    }
  };

  const unsubscribe = async () => {
    setError('');
    try {
      await updateDigest.mutateAsync({ enabled: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    }
  };

  return (
    <section className="synapse-card rounded-[28px] p-5 md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Weekly updates
          </p>
          <h2 className="mt-1 text-lg font-semibold text-neutral-950 dark:text-white">
            Get a weekly digest for this case
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-600 dark:text-neutral-300">
            We&rsquo;ll email new research, trials, and expert discussion on{' '}
            {healthCase.condition_terms?.length
              ? healthCase.condition_terms.slice(0, 3).join(', ')
              : 'this case'}{' '}
            as it appears — every claim cited.
          </p>
        </div>

        {enabled ? (
          <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
              <span aria-hidden>✓</span> Subscribed
            </span>
            <button
              type="button"
              onClick={unsubscribe}
              disabled={updateDigest.isPending}
              className="text-xs text-neutral-500 underline-offset-2 hover:underline disabled:opacity-60 dark:text-neutral-400"
            >
              {updateDigest.isPending ? 'Updating…' : 'Unsubscribe'}
            </button>
          </div>
        ) : (
          <div className="flex w-full shrink-0 flex-col gap-2 sm:flex-row md:w-auto">
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              aria-label="Email for weekly updates"
              className="w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100 sm:w-64 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:placeholder:text-neutral-500 dark:focus:border-sky-500 dark:focus:ring-sky-950"
              data-posthog-mask
            />
            <Button onClick={subscribe} disabled={updateDigest.isPending} className="rounded-2xl">
              {updateDigest.isPending ? 'Subscribing…' : 'Subscribe'}
            </Button>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

export function HealthCaseDetail({ caseId }: { caseId: string }) {
  const router = useRouter();
  useImmersiveSidebar();
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
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  // Synchronous lock for the brief-generation guard. `useState` /
  // `activeBriefMessageId` would lag behind a fast double-click because the
  // state setter is queued for the next render — a `useRef` flips
  // immediately and is shared across closures.
  const briefGenerationLock = useRef(false);
  // `?continue=1` is set by the intake "Yes — create Health Case" button.
  // Since the user already confirmed there, we auto-start Expert Research on
  // arrival instead of asking them to type "yes" a second time.
  const [continueParam, setContinueParam] = useQueryState('continue');
  const autoStartedRef = useRef(false);

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
          sources: savedBrief.sources || [],
          citationGrounding: savedBrief.citation_grounding || null,
        });
      }
    }

    setMessages(seeded);
  }, [data, caseId]);

  // Scroll only the chat container, not the window — see CreateCaseCard.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
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
              toolEvents: brief.toolEvents,
              thinking: brief.thinking,
              activeTool: brief.activeTool,
              progressMeta: brief.progressMeta,
              startedAtMs: brief.startedAtMs,
              researchers: brief.savedBrief?.researchers || message.researchers,
              clinicalTrials: brief.savedBrief?.clinical_trials || message.clinicalTrials,
              feedSuggestions: brief.savedBrief?.feed_suggestions || message.feedSuggestions,
              sources: brief.savedBrief?.sources || message.sources,
              citationGrounding: brief.savedBrief?.citation_grounding || message.citationGrounding,
              generatedAtIso: brief.savedBrief?.created_at || message.generatedAtIso,
            }
          : message
      )
    );
  }, [
    activeBriefMessageId,
    brief.content,
    brief.isStreaming,
    brief.savedBrief,
    brief.toolEvents,
    brief.thinking,
    brief.activeTool,
    brief.progressMeta,
    brief.startedAtMs,
  ]);

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

  const briefProgressPhrase = useCyclingPhrase(
    BRIEF_PROGRESS_PHRASES,
    brief.isStreaming && !activeBriefMessageId
  );
  const briefPendingLabel = upload.isPending
    ? 'Uploading...'
    : brief.isStreaming
      ? briefProgressPhrase
      : 'Send';

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

  // Auto-kick the brief once when the user arrives straight from confirming
  // the case ("Yes — create Health Case" → `?continue=1`). We clear the param
  // first so a refresh or back-nav doesn't re-trigger another LLM pass, and
  // gate on `seededRef` so the auto-started turn lands after the seeded
  // case-summary message.
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (continueParam !== '1') return;
    if (!data || !seededRef.current) return;
    if (brief.isStreaming || briefGenerationLock.current) return;
    autoStartedRef.current = true;
    void setContinueParam(null);
    void startBrief();
  }, [continueParam, data, brief.isStreaming, startBrief, setContinueParam]);

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

  if (isLoading) {
    return (
      <>
        <SidebarRestoreHandle />
        <PageSkeleton variant="single" />
      </>
    );
  }
  if (error) return <p className="p-8 text-sm text-red-600">{error.message}</p>;
  if (!data) return null;

  const detailComposer = (
    <ChatComposer
      embedded
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
      pendingLabel={briefPendingLabel}
      submitLabel="Send"
      placeholder={
        canGenerate
          ? 'Reply yes to generate, ask a follow-up, or attach records'
          : 'Add context, attach records, or wait while we prepare the case'
      }
      disabled={brief.isStreaming || upload.isPending}
    />
  );

  return (
    <div className="min-h-screen">
      <SidebarRestoreHandle />
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-4 py-8 md:p-8 lg:py-10">
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

        <DigestSubscribeCard healthCase={data} />

        <HealthCaseVoiceAgent caseId={caseId} />

        <BorderBeam size="md" duration={9} colorVariant="ocean" theme="auto" className="w-full">
          <section className="relative overflow-hidden rounded-[36px] synapse-glass-strong">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(78,157,252,0.16),transparent_28rem),radial-gradient(circle_at_80%_10%,rgba(129,140,248,0.12),transparent_24rem)]" />

            <div className="relative p-4 md:p-6 lg:p-8">
              <div className="flex max-h-[min(720px,78vh)] flex-col overflow-hidden rounded-[30px] border border-white/70 bg-white/45 shadow-inner dark:border-white/[0.06] dark:bg-black/10">
                <div
                  ref={messagesContainerRef}
                  className="min-h-[280px] flex-1 space-y-5 overflow-y-auto p-4 pr-2 md:p-6"
                >
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
                    const briefIsComplete =
                      !message.isStreaming && message.content.trim().length > 0;
                    return (
                      <ChatBubble key={message.id} role="assistant" inline>
                        <div className="rounded-3xl rounded-tl-md border border-neutral-200 bg-white p-4 text-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                              Expert Research
                            </p>
                            {message.isStreaming ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-300">
                                <GoogleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                Working
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
                          {message.isStreaming && (
                            <BriefProgress
                              toolEvents={message.toolEvents || []}
                              thinking={message.thinking || ''}
                              activeTool={message.activeTool ?? null}
                              isStreaming={message.isStreaming}
                              hasContent={Boolean(message.content)}
                              startedAtMs={message.startedAtMs ?? null}
                              progressMeta={message.progressMeta ?? null}
                            />
                          )}
                          {message.content ? (
                            <>
                              <ExpertResearchBrief
                                caseId={data.id}
                                content={message.content}
                                researchers={message.researchers}
                                clinicalTrials={message.clinicalTrials}
                                feedSuggestions={message.feedSuggestions}
                                sources={message.sources}
                                citationGrounding={message.citationGrounding}
                              />
                              {briefIsComplete && briefHasStructuredSections(message.content) ? (
                                <BriefFinishedActions
                                  caseId={data.id}
                                  feedSuggestions={message.feedSuggestions}
                                  conditionTerms={data.condition_terms || []}
                                />
                              ) : null}
                            </>
                          ) : !message.isStreaming ? (
                            <BriefGeneratingPlaceholder />
                          ) : null}
                        </div>
                      </ChatBubble>
                    );
                  })}
                  {brief.isStreaming && !activeBriefMessageId && (
                    <ChatTypingBubble
                      useGemini
                      label={briefProgressPhrase}
                      detail="Gemini is consulting papers, guidelines, trials, and web sources"
                    />
                  )}
                </div>

                <div className="shrink-0 space-y-3 border-t border-white/70 bg-white/75 p-3 backdrop-blur-md dark:border-white/[0.06] dark:bg-neutral-950/80 md:p-4">
                  {detailComposer}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      className="rounded-2xl"
                      disabled={!canGenerate}
                      onClick={() => startBrief()}
                    >
                      {brief.isStreaming ? briefProgressPhrase : 'Generate Expert Research'}
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
              </div>
            </div>
          </section>
        </BorderBeam>
      </main>
    </div>
  );
}
