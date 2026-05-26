'use client';

import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { BriefBlock, BriefSectionNode, ParsedBrief } from './briefPdf';
import type {
  HealthCaseClinicalTrial,
  HealthCaseFeedSuggestion,
  HealthCaseResearcher,
} from '@/app/hooks/useHealthCases';

const palette = {
  ink: '#02182c',
  bodyInk: '#1f2937',
  muted: '#6b7280',
  accent: '#0369a1',
  accentSoft: '#e0f2fe',
  betaInk: '#92400e',
  betaSoft: '#fef3c7',
  hairline: '#e5e7eb',
  pageBackground: '#ffffff',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 110,
    paddingBottom: 60,
    paddingHorizontal: 48,
    fontFamily: 'Helvetica',
    fontSize: 10.5,
    color: palette.bodyInk,
    backgroundColor: palette.pageBackground,
    lineHeight: 1.5,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 28,
    paddingBottom: 18,
    paddingHorizontal: 48,
    borderBottomWidth: 1,
    borderBottomColor: palette.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandLogo: {
    width: 28,
    height: 28,
    marginRight: 10,
  },
  brandText: {
    flexDirection: 'column',
  },
  brandWordmark: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: palette.ink,
    letterSpacing: 0.4,
  },
  brandTagline: {
    fontSize: 8.5,
    color: palette.muted,
    marginTop: 2,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  betaPill: {
    fontSize: 8.5,
    color: palette.betaInk,
    backgroundColor: palette.betaSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.6,
  },
  titleBlock: {
    marginTop: 4,
    marginBottom: 18,
  },
  title: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 22,
    color: palette.ink,
    lineHeight: 1.25,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  metaChip: {
    fontSize: 9,
    color: palette.accent,
    backgroundColor: palette.accentSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginRight: 6,
    marginBottom: 6,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  generatedAt: {
    fontSize: 9,
    color: palette.muted,
    marginTop: 4,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: palette.hairline,
    marginVertical: 14,
  },
  section: {
    marginBottom: 18,
  },
  sectionEyebrow: {
    fontSize: 8.5,
    color: palette.accent,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 14,
    color: palette.ink,
    marginBottom: 10,
  },
  paragraph: {
    fontSize: 10.5,
    color: palette.bodyInk,
    marginBottom: 8,
    lineHeight: 1.55,
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 6,
    paddingRight: 4,
  },
  bulletGlyph: {
    width: 12,
    fontSize: 10.5,
    color: palette.accent,
    fontFamily: 'Helvetica-Bold',
  },
  bulletText: {
    flex: 1,
    fontSize: 10.5,
    color: palette.bodyInk,
    lineHeight: 1.55,
  },
  numberedGlyph: {
    width: 18,
    fontSize: 10.5,
    color: palette.accent,
    fontFamily: 'Helvetica-Bold',
  },
  structuredCard: {
    borderWidth: 1,
    borderColor: palette.hairline,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  structuredLabel: {
    fontSize: 8.5,
    color: palette.accent,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  structuredTitle: {
    fontSize: 11,
    color: palette.ink,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 3,
  },
  structuredMeta: {
    fontSize: 9,
    color: palette.muted,
    marginBottom: 4,
  },
  structuredBody: {
    fontSize: 9.5,
    color: palette.bodyInk,
    lineHeight: 1.45,
  },
  footerLine: {
    // Anchor by `top` against the explicit Letter page height (792pt)
    // instead of `bottom`. React-PDF v4 mis-positions `bottom`-anchored
    // fixed elements on a short last page (we hit this with a 5-page
    // brief whose final page only filled half the canvas — the footer
    // rendered above the header). `top` is computed from the page edge
    // and renders consistently regardless of content fill.
    position: 'absolute',
    top: 760,
    left: 48,
    right: 48,
    paddingTop: 8,
    fontSize: 8,
    color: palette.muted,
    borderTopWidth: 1,
    borderTopColor: palette.hairline,
  },
});

function BlockView({ block }: { block: BriefBlock }) {
  if (block.kind === 'paragraph') {
    return <Text style={styles.paragraph}>{block.text}</Text>;
  }
  if (block.kind === 'bullet') {
    return (
      <View style={styles.bulletRow} wrap={false}>
        <Text style={styles.bulletGlyph}>•</Text>
        <Text style={styles.bulletText}>{block.text}</Text>
      </View>
    );
  }
  return (
    <View style={styles.bulletRow} wrap={false}>
      <Text style={styles.numberedGlyph}>{block.index}.</Text>
      <Text style={styles.bulletText}>{block.text}</Text>
    </View>
  );
}

function SectionView({ section }: { section: BriefSectionNode }) {
  return (
    <View style={styles.section} wrap>
      <Text style={styles.sectionEyebrow}>Expert Research</Text>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      {section.blocks.length === 0 ? (
        <Text style={styles.paragraph}>
          Synapse didn&rsquo;t return content for this section. Try regenerating the brief.
        </Text>
      ) : (
        section.blocks.map((block, index) => (
          <BlockView key={`${section.id}-${index}`} block={block} />
        ))
      )}
    </View>
  );
}

export interface BriefPdfDocumentProps {
  caseTitle: string;
  conditionTerms: string[];
  brief: ParsedBrief;
  generatedAtIso: string;
  logoSrc?: string;
  researchers?: HealthCaseResearcher[];
  clinicalTrials?: HealthCaseClinicalTrial[];
  feedSuggestions?: HealthCaseFeedSuggestion[];
}

function StructuredOutputsView({
  researchers,
  clinicalTrials,
  feedSuggestions,
}: {
  researchers?: HealthCaseResearcher[];
  clinicalTrials?: HealthCaseClinicalTrial[];
  feedSuggestions?: HealthCaseFeedSuggestion[];
}) {
  const hasStructured =
    Boolean(researchers?.length) ||
    Boolean(clinicalTrials?.length) ||
    Boolean(feedSuggestions?.length);
  if (!hasStructured) return null;

  return (
    <View style={styles.section} wrap>
      <Text style={styles.sectionEyebrow}>Structured Outputs</Text>
      <Text style={styles.sectionTitle}>Actionable Links and Profiles</Text>

      {(feedSuggestions || []).slice(0, 3).map((feed) => (
        <View key={`feed-${feed.topic}`} style={styles.structuredCard} wrap={false}>
          <Text style={styles.structuredLabel}>Feed</Text>
          <Text style={styles.structuredTitle}>{feed.topic}</Text>
          <Text style={styles.structuredBody}>{feed.description}</Text>
          {feed.search_terms?.length ? (
            <Text style={styles.structuredMeta}>
              Search terms: {feed.search_terms.slice(0, 8).join(', ')}
            </Text>
          ) : null}
        </View>
      ))}

      {(researchers || []).slice(0, 8).map((researcher) => (
        <View key={`researcher-${researcher.name}`} style={styles.structuredCard} wrap={false}>
          <Text style={styles.structuredLabel}>Researcher</Text>
          <Text style={styles.structuredTitle}>{researcher.name}</Text>
          <Text style={styles.structuredMeta}>
            {[researcher.specialty, researcher.institution].filter(Boolean).join(' · ') ||
              (researcher.matched ? 'Synapse profile matched' : 'Profile not matched yet')}
          </Text>
          {researcher.rationale ? (
            <Text style={styles.structuredBody}>{researcher.rationale}</Text>
          ) : null}
          {researcher.profile_url ? (
            <Text style={styles.structuredMeta}>Profile: {researcher.profile_url}</Text>
          ) : null}
        </View>
      ))}

      {(clinicalTrials || []).slice(0, 10).map((trial) => (
        <View key={`trial-${trial.nct_id}`} style={styles.structuredCard} wrap={false}>
          <Text style={styles.structuredLabel}>Clinical Trial</Text>
          <Text style={styles.structuredTitle}>
            {trial.nct_id} — {trial.title || 'Clinical trial'}
          </Text>
          <Text style={styles.structuredMeta}>
            {[trial.status, trial.phase, trial.enrollment ? `${trial.enrollment} enrolled` : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {trial.fit_rationale ? (
            <Text style={styles.structuredBody}>{trial.fit_rationale}</Text>
          ) : null}
          <Text style={styles.structuredMeta}>
            ClinicalTrials.gov: {trial.url || `https://clinicaltrials.gov/study/${trial.nct_id}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function BriefPdfDocument({
  caseTitle,
  conditionTerms,
  brief,
  generatedAtIso,
  logoSrc,
  researchers,
  clinicalTrials,
  feedSuggestions,
}: BriefPdfDocumentProps) {
  const generatedAtLabel = new Date(generatedAtIso).toLocaleString(undefined, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const chips = (conditionTerms || []).slice(0, 6);

  return (
    <Document
      title={`Synapse Expert Research — ${caseTitle}`}
      author="Synapse"
      subject="Cardiology Expert Research brief"
      creator="Synapse Health Cases"
      producer="Synapse"
    >
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.header} fixed>
          <View style={styles.brand}>
            {logoSrc ? <Image style={styles.brandLogo} src={logoSrc} /> : null}
            <View style={styles.brandText}>
              <Text style={styles.brandWordmark}>Synapse</Text>
              <Text style={styles.brandTagline}>Expert Research</Text>
            </View>
          </View>
          <Text style={styles.betaPill}>BETA · CARDIOLOGY</Text>
        </View>

        <View style={styles.titleBlock}>
          {/* `hyphenationCallback` returning [word] keeps long titles like
              "Type 2 Diabetes" from being broken mid-word by the default
              hyphenation engine. */}
          <Text style={styles.title} hyphenationCallback={(word) => [word]}>
            {caseTitle}
          </Text>
          {chips.length > 0 && (
            <View style={styles.metaRow}>
              {chips.map((chip) => (
                <Text key={chip} style={styles.metaChip}>
                  {chip}
                </Text>
              ))}
            </View>
          )}
          <Text style={styles.generatedAt}>Generated {generatedAtLabel}</Text>
        </View>

        <View style={styles.divider} />

        {brief.preamble.length > 0 && (
          <View style={styles.section} wrap>
            {brief.preamble.map((block, index) => (
              <BlockView key={`preamble-${index}`} block={block} />
            ))}
          </View>
        )}

        {brief.sections.map((section) => (
          <SectionView key={section.id} section={section} />
        ))}

        <StructuredOutputsView
          researchers={researchers}
          clinicalTrials={clinicalTrials}
          feedSuggestions={feedSuggestions}
        />

        {/* Single `<Text fixed render>` for the whole footer. React-PDF v4
            wraps separate fixed children inconsistently when the last page
            is short — combining the disclaimer and page count into one
            string keeps both at page bottom on every page. */}
        <Text
          style={styles.footerLine}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Synapse · Expert Research · Educational research only — not a diagnosis or medical advice.    ${pageNumber} / ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
