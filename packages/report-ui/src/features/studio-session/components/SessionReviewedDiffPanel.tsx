import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionViewModel } from '../sessionViewModel';

type PatchLineKind = 'file' | 'hunk' | 'added' | 'removed' | 'meta' | 'context';
type ReviewedDiffFile = SessionViewModel['reviewedDiff']['files'][number];

interface PatchLineViewModel {
  raw: string;
  kind: PatchLineKind;
  marker: string;
  content: string;
}

interface PatchSectionViewModel {
  id: string;
  path: string;
  status: string;
  lines: PatchLineViewModel[];
}

function classifyPatchLine(line: string): PatchLineKind {
  if (line.startsWith('diff --git') || line.startsWith('+++ ') || line.startsWith('--- ')) {
    return 'file';
  }
  if (
    line.startsWith('index ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('+')) {
    return 'added';
  }
  if (line.startsWith('-')) {
    return 'removed';
  }
  return 'context';
}

function patchLineMarker(line: string, kind: PatchLineKind): string {
  if (kind === 'added' || kind === 'removed') {
    return line.charAt(0);
  }
  if (kind === 'hunk') {
    return '@@';
  }
  return '';
}

function parseDiffHeaderPath(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match ? match[2] : null;
}

function slugifyPath(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function buildPatchLine(raw: string): PatchLineViewModel {
  const kind = classifyPatchLine(raw);
  const marker = patchLineMarker(raw, kind);
  return {
    raw,
    kind,
    marker,
    content: marker && kind !== 'hunk' ? raw.slice(1) : raw,
  };
}

function buildPatchSections(patch: string, files: ReviewedDiffFile[]): PatchSectionViewModel[] {
  const lines = patch.split('\n');
  const groups: string[][] = [];
  let currentGroup: string[] = [];

  lines.forEach((line) => {
    if (line.startsWith('diff --git ') && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [line];
      return;
    }
    currentGroup.push(line);
  });

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const normalizedGroups = groups.length > 0 ? groups : [lines];

  return normalizedGroups.map((group, index) => {
    const file = files[index];
    const derivedPath = group.find((line) => line.startsWith('diff --git '))
      ? parseDiffHeaderPath(group.find((line) => line.startsWith('diff --git ')) ?? '')
      : null;
    const path = file?.path ?? derivedPath ?? `file-${index + 1}`;
    return {
      id: `reviewed-diff-${slugifyPath(path) || index}`,
      path,
      status: file?.status ?? 'modified',
      lines: group.map((raw) => buildPatchLine(raw)),
    };
  });
}

export function SessionReviewedDiffPanel(props: { reviewedDiff: SessionViewModel['reviewedDiff'] }): JSX.Element {
  const sections = useMemo(
    () => (props.reviewedDiff.patch ? buildPatchSections(props.reviewedDiff.patch, props.reviewedDiff.files) : []),
    [props.reviewedDiff.files, props.reviewedDiff.patch]
  );
  const [expandedSections, setExpandedSections] = useState<boolean[]>([]);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    setExpandedSections(sections.map(() => true));
    sectionRefs.current = sections.map((_, index) => sectionRefs.current[index] ?? null);
  }, [sections]);

  if (!props.reviewedDiff.visible) {
    return <div className="empty-card">{props.reviewedDiff.emptyMessage}</div>;
  }

  const areAllExpanded = sections.length > 0 && sections.every((_, index) => expandedSections[index] !== false);

  function setAllSections(nextExpanded: boolean): void {
    setExpandedSections(sections.map(() => nextExpanded));
  }

  function toggleSection(index: number): void {
    setExpandedSections((current) =>
      sections.map((_, valueIndex) => {
        const currentValue = current[valueIndex] !== false;
        return valueIndex === index ? !currentValue : currentValue;
      })
    );
  }

  function jumpToSection(index: number): void {
    setExpandedSections((current) =>
      sections.map((_, valueIndex) => (valueIndex === index ? true : current[valueIndex] !== false))
    );
    window.setTimeout(() => {
      sectionRefs.current[index]?.scrollIntoView({
        block: 'start',
        behavior: 'smooth',
      });
    }, 0);
  }

  return (
    <div className="diff-card session-diff-card">
      <div className="session-diff-toolbar">
        <div className="diff-meta">
          {props.reviewedDiff.summaryItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        {sections.length > 1 ? (
          <div className="session-diff-controls">
            <button
              type="button"
              className="session-diff-control"
              onClick={() => setAllSections(true)}
              disabled={areAllExpanded}
            >
              Expand all
            </button>
            <button
              type="button"
              className="session-diff-control"
              onClick={() => setAllSections(false)}
              disabled={!areAllExpanded}
            >
              Collapse all
            </button>
          </div>
        ) : null}
      </div>
      {props.reviewedDiff.files.length > 0 ? (
        <div className="session-file-list">
          {props.reviewedDiff.files.map((file, index) => (
            <button
              key={`${file.status}-${file.path}`}
              type="button"
              className="session-file-chip session-file-button"
              onClick={() => jumpToSection(index)}
              aria-label={`Jump to ${file.path}`}
              title={`Jump to ${file.path}`}
            >
              {file.status}
              {' '}
              {file.path}
            </button>
          ))}
        </div>
      ) : null}
      {props.reviewedDiff.patch ? (
        <div className="session-diff-sections">
          {sections.map((section, index) => {
            const expanded = expandedSections[index] !== false;
            return (
              <section
                key={section.id}
                id={section.id}
                ref={(node) => {
                  sectionRefs.current[index] = node;
                }}
                className="session-diff-section"
              >
                <div className="session-diff-section-header">
                  <div className="session-diff-section-heading">
                    <span className="session-file-chip session-file-chip-static">
                      {section.status}
                    </span>
                    <strong className="session-diff-section-path">{section.path}</strong>
                  </div>
                  <button
                    type="button"
                    className="session-diff-toggle"
                    onClick={() => toggleSection(index)}
                    aria-expanded={expanded}
                    aria-controls={`${section.id}-body`}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.path}`}
                  >
                    {expanded ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                {expanded ? (
                  <div
                    id={`${section.id}-body`}
                    className="session-patch-view"
                    role="region"
                    aria-label={`Reviewed diff patch for ${section.path}`}
                  >
                    {section.lines.map((line, lineIndex) => (
                      <div key={`${lineIndex}-${line.raw}`} className={`session-patch-line ${line.kind}`}>
                        <span className="session-patch-marker" aria-hidden="true">
                          {line.marker}
                        </span>
                        <span className="session-patch-content">{line.content || '\u00A0'}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="empty-card">Nimbus has the changed-file summary, but not a patch body for this diff.</div>
      )}
    </div>
  );
}
