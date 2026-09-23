import { useEffect, useState } from 'react'
import { Badge, Box, Group, Loader, Modal, Text, useComputedColorScheme } from '@mantine/core'
import { DiffEditor, type Monaco } from '@monaco-editor/react'
import { XTERM_THEMES } from './TerminalPane'
import { getFileDiff } from './api'
import type { FileDiff } from './types'
import { CODE_FONT_SIZE, fontStack, useAppearance, whenFontLoaded } from './theme'

// Extension → Monaco language id (best-effort; unknown falls back to plaintext).
const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml', md: 'markdown',
  py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', sql: 'sql', swift: 'swift', dockerfile: 'dockerfile'
}
const langFor = (path: string) => LANG[path.split('.').pop()?.toLowerCase() || ''] || 'plaintext'

// One Dark Pro's palette on the terminal's background, so a diff reads like the panes
// around it. Registered once, before the editor mounts.
const ONE_DARK = 'jeeves-one-dark-pro'
function defineOneDark(monaco: Monaco) {
  const bg = XTERM_THEMES.dark.background
  monaco.editor.defineTheme(ONE_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'abb2bf' },
      { token: 'comment', foreground: '7f848e', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'keyword.operator', foreground: '56b6c2' },
      { token: 'operator', foreground: '56b6c2' },
      { token: 'delimiter', foreground: 'abb2bf' },
      { token: 'string', foreground: '98c379' },
      { token: 'string.escape', foreground: '56b6c2' },
      { token: 'regexp', foreground: '56b6c2' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'constant', foreground: 'd19a66' },
      { token: 'type', foreground: 'e5c07b' },
      { token: 'type.identifier', foreground: 'e5c07b' },
      { token: 'identifier', foreground: 'e06c75' },
      { token: 'variable', foreground: 'e06c75' },
      { token: 'variable.predefined', foreground: 'e5c07b' },
      { token: 'function', foreground: '61afef' },
      { token: 'predefined', foreground: '61afef' },
      { token: 'tag', foreground: 'e06c75' },
      { token: 'attribute.name', foreground: 'd19a66' },
      { token: 'attribute.value', foreground: '98c379' },
      { token: 'metatag', foreground: 'c678dd' },
      { token: 'key', foreground: 'e06c75' },
      { token: 'string.key.json', foreground: 'e06c75' },
      { token: 'string.value.json', foreground: '98c379' },
      { token: 'keyword.md', foreground: 'e06c75' },
      { token: 'markup.heading', foreground: 'e06c75', fontStyle: 'bold' }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': '#abb2bf',
      'editorGutter.background': bg,
      'editorLineNumber.foreground': '#495162',
      'editorLineNumber.activeForeground': '#abb2bf',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.selectionBackground': '#67769660',
      'editorIndentGuide.background1': '#ffffff0f',
      'editorWhitespace.foreground': '#3b4048',
      'editorOverviewRuler.border': bg,
      'scrollbarSlider.background': '#4e566680',
      'scrollbarSlider.hoverBackground': '#5a637580',
      'diffEditor.insertedTextBackground': '#98c37917',
      'diffEditor.removedTextBackground': '#e06c751c',
      'diffEditor.insertedLineBackground': '#98c3790b',
      'diffEditor.removedLineBackground': '#e06c750d',
      'diffEditor.diagonalFill': '#ffffff0a',
      'diffEditor.border': '#ffffff12'
    }
  })
}

// Read-only side-by-side diff of one changed file, themed to the app's scheme.
// Two modes (from `base`): default is HEAD vs working tree (uncommitted changes);
// with `base` set it's merge-base(base, HEAD) vs HEAD (the PR diff). Monaco is
// fetched by its loader on first open.
export function DiffModal({ cwd, path, base, onClose }: { cwd: string; path: string | null; base?: string; onClose: () => void }) {
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const scheme = useComputedColorScheme('dark')
  const { monoFont } = useAppearance()
  // Monaco measures character widths when it mounts and when options change; if the
  // web font arrives after that, it keeps the fallback's widths (misplaced cursor and
  // selection). Re-measure once the font has loaded.
  const [monacoApi, setMonacoApi] = useState<Monaco | null>(null)
  useEffect(() => {
    if (!monacoApi) return
    let live = true
    whenFontLoaded(monoFont, CODE_FONT_SIZE).then(() => { if (live) monacoApi.editor.remeasureFonts() })
    return () => { live = false }
  }, [monacoApi, monoFont])

  useEffect(() => {
    if (!path) { setDiff(null); return }
    let cancelled = false
    setLoading(true)
    getFileDiff(cwd, path, base).then((d) => { if (!cancelled) setDiff(d) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cwd, path, base])

  return (
    <Modal
      opened={!!path}
      onClose={onClose}
      size="90%"
      title={
        <Group gap={8} wrap="nowrap">
          <Text size="sm" ff="monospace" truncate>{path}</Text>
          <Badge size="xs" variant="light" color="gray">read-only</Badge>
        </Group>
      }
      styles={{ body: { padding: 0, height: '80vh' }, content: { height: '86vh' } }}
    >
      {loading && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {!loading && diff?.error && <Box p="md"><Text size="sm" c="red">{diff.error}</Text></Box>}
      {!loading && diff?.binary && <Box p="md"><Text size="sm" c="dimmed">Binary file — no text diff.</Text></Box>}
      {!loading && diff && !diff.error && !diff.binary && path && (
        <DiffEditor
          original={diff.old ?? ''}
          modified={diff.new ?? ''}
          language={langFor(path)}
          beforeMount={defineOneDark}
          onMount={(_editor, monaco) => setMonacoApi(monaco)}
          theme={scheme === 'dark' ? ONE_DARK : 'vs'}
          height="100%"
          options={{
            readOnly: true,
            renderSideBySide: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: CODE_FONT_SIZE,
            fontFamily: fontStack(monoFont, 'mono')
          }}
        />
      )}
    </Modal>
  )
}
